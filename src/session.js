'use strict';
/**
 * Session = satu akun WhatsApp: socket, auth terenkripsi, reconnect, pipeline event, plugin, log, database.
 */
const EventEmitter = require('events');
const path = require('path');
const paths = require('./paths');
const U = require('./utils');
const hot = require('./hot');
const db = require('./db');
const baileys = require('./baileys');
const cryptoAuth = require('./crypto-auth');
const backup = require('./backup');
const { PluginManager } = require('./plugin-manager');

// Daftar event dari dokumentasi @itsliaaa/baileys
const EVENTS = [
  'connection.update', 'creds.update', 'messaging-history.set', 'messaging-history.status', 'chats.upsert', 'chats.update',
  'chats.delete', 'chats.lock', 'lid-mapping.update', 'presence.update', 'contacts.upsert', 'contacts.update', 'messages.delete',
  'messages.update', 'messages.media-update', 'messages.upsert', 'messages.reaction', 'message-receipt.update', 'groups.upsert',
  'groups.update', 'group-participants.update', 'group.join-request', 'group.member-tag.update', 'blocklist.set', 'blocklist.update',
  'call', 'labels.edit', 'labels.association', 'newsletter.reaction', 'newsletter.view', 'newsletter-participants.update',
  'newsletter-settings.update', 'settings.update',
];

class Session extends EventEmitter {
  constructor(manager, name, info) {
    super();
    this.manager = manager;
    this.name = name;
    this.info = info; // referensi ke core.json sessions[name]
    this.status = 'stopped'; // stopped|starting|connecting|open|reconnecting|logged_out|replaced|failed|stopping
    this.sock = null;
    this.rawSock = null;
    this.baileys = null;
    this.authState = null;
    this.saveCreds = null;
    this.authFolder = path.join(paths.AUTH, name);
    this.db = null;
    this.logs = null;
    this.logger = null;
    this.baileysLogger = null;
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(200);
    this.plugins = null;
    this.me = null;
    this.botJid = '';
    this.botLid = '';
    this.botIds = new Set();
    this.connectedAt = 0;
    this.startedAt = 0;
    this.retries = 0;
    this.qr = null;
    this.pairingCode = null;
    this.lastError = null;
    this.stopping = false;
    this.reconnectTimer = null;
    this.sentCache = new U.LRU(500);
    this.sentIds = new U.LRU(1000);
    this.seenIds = new U.LRU(2000);
    this.backedUpThisRun = false;
    this.pairingRequested = false;
    this.generation = 0;
  }

  /* --------------------------------- helper publik --------------------------------- */

  get config() { return this.manager.config; }
  getPrefix() { return this.db.data.settings.prefix || this.config.get('bot.prefix'); }
  getMode() { return this.db.data.settings.mode || this.config.get('bot.defaultMode'); }
  richEnabled() {
    const v = this.db.data.settings.richEnabled;
    return v === null || v === undefined ? this.config.get('bot.richEnabled') : v;
  }
  isBotNoi(jid) {
    if (!jid) return false;
    return this.botIds.has(U.normalizeJid(jid)) || this.botIds.has(U.jidUser(jid) + '@s.whatsapp.net') || this.botIds.has(U.jidUser(jid) + '@lid');
  }
  groupName(jid) { return hot('groups').name(this, jid); }
  getStatusAudience() {
    const self = [this.botJid, this.botLid].filter(Boolean).map(U.normalizeJid);
    if (this.config.get('status.audience') === 'self') return [...new Set(self)];
    const list = Object.keys(this.db.data.contacts).filter((j) => j.endsWith('@s.whatsapp.net') || j.endsWith('@lid'));
    return [...new Set([...self, ...list])];
  }
  summary() {
    return {
      name: this.name, status: this.status, method: this.info.method, phone: this.info.phone || null, jid: this.botJid || null,
      mode: this.db ? this.getMode() : null, uptimeMs: this.connectedAt ? Date.now() - this.connectedAt : 0,
      retries: this.retries, plugins: this.plugins ? this.plugins.status().filter((p) => p.state === 'running').length : 0,
      lastError: this.lastError,
    };
  }
  touchContact(jid, name) {
    if (!jid || !this.db) return;
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) return;
    const k = U.normalizeJid(jid);
    const c = this.db.data.contacts[k];
    if (!c) { this.db.data.contacts[k] = { name: '', notify: name || '', seenAt: Date.now() }; this.db.save(); return; }
    if (name && c.notify !== name && !c.name) { c.notify = name; this.db.save(); }
  }

  _setStatus(s, extra) {
    const prev = this.status;
    this.status = s;
    this.info.lastStatus = s;
    this.manager.coreStore.save();
    if (prev !== s) {
      this.logger && this.logger.info({ event: 'session.status', from: prev, to: s, ...extra }, `Status ${this.name}: ${prev} → ${s}`);
      this.emit('status', s, prev);
    }
  }

  /* ------------------------------------- start ------------------------------------- */

  async start() {
    if (['starting', 'connecting', 'open', 'reconnecting'].includes(this.status)) return;
    this.stopping = false;
    this.retries = 0;
    this.backedUpThisRun = false;
    this.lastError = null;
    this.startedAt = Date.now();
    this.logs = await this.manager.logs.openScope(this.name); // sesi log BARU tiap start/restart
    this.logger = this.logs.logger('session');
    this.baileysLogger = this.logs.logger('baileys', {}, this.config.get('logging.baileysLevel'));
    this._setStatus('starting');
    this.logger.info({ event: 'session.start', method: this.info.method }, `Memulai sesi "${this.name}"`);
    try {
      this.baileys = await baileys.load();
      this.db = await db.openAccount(this.name);
      this.plugins = new PluginManager(this);
      this.plugins.scan();
      await this.plugins.startAll();
      await this._connect();
    } catch (err) {
      this.lastError = err.message;
      this.logger.fatal({ event: 'session.start_failed', err }, `Gagal memulai sesi: ${err.message}`);
      this._setStatus('failed');
      throw err;
    }
  }

  async _connect() {
    const bl = this.baileys;
    const gen = ++this.generation;
    const { state, saveCreds, isNew } = await cryptoAuth.useEncryptedMultiFileAuthState(this.authFolder, { baileys: bl, logger: this.logs.logger('auth') });
    this.authState = state;
    this.saveCreds = saveCreds;
    this.logs.logger('auth').info({ event: 'auth.loaded', isNew, registered: !!state.creds.registered }, isNew ? 'Auth baru dibuat (belum login)' : 'Auth terenkripsi dimuat dari disk');
    this.pairingRequested = false;
    this.qr = null;

    const browser = bl.Browsers && bl.Browsers.ubuntu ? bl.Browsers.ubuntu(this.config.get('connection.browserName')) : ['Ubuntu', this.config.get('connection.browserName'), '22.04.4'];
    const raw = bl.makeWASocket({
      auth: state,
      logger: this.baileysLogger,
      printQRInTerminal: false,
      browser,
      markOnlineOnConnect: this.config.get('connection.markOnline'),
      syncFullHistory: this.config.get('connection.syncFullHistory'),
      getMessage: async (key) => {
        const m = this.sentCache.get(key.id);
        return m ? m.message : undefined;
      },
    });
    this.rawSock = raw;
    this.sock = this._wrapSock(raw);
    this._setStatus('connecting');
    for (const ev of EVENTS) {
      raw.ev.on(ev, (payload) => {
        if (gen !== this.generation) return; // socket lama
        this._onEvent(ev, payload).catch((err) => this.logger.error({ event: 'event.handler_error', name: ev, err }, `Handler event ${ev} error: ${err.message}`));
      });
    }
  }

  _teardownSocket() {
    const raw = this.rawSock;
    this.generation++;
    this.rawSock = null;
    if (!raw) return;
    for (const ev of EVENTS) { try { raw.ev.removeAllListeners(ev); } catch { /* ignore */ } }
    try { raw.end(undefined); } catch { /* ignore */ }
  }

  /** Proxy: setiap pemanggilan fungsi socket oleh bot dicatat ke log; sendMessage dicatat detail. */
  _wrapSock(raw) {
    const self = this;
    return new Proxy(raw, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof v !== 'function' || typeof prop !== 'string') return v;
        if (prop === 'sendMessage') return (jid, content, opts) => self._send(target, jid, content, opts);
        return (...args) => {
          self.logger.debug({ event: 'sock.call', fn: prop, args: U.sanitize(args, { maxDepth: 3, maxString: 200 }) }, `sock.${prop}()`);
          let res;
          try { res = v.apply(target, args); } catch (err) {
            self.logger.error({ event: 'sock.call_error', fn: prop, err }, `sock.${prop}() error: ${err.message}`);
            throw err;
          }
          if (res && typeof res.then === 'function') {
            return res.then((r) => r, (err) => { self.logger.error({ event: 'sock.call_error', fn: prop, err }, `sock.${prop}() gagal: ${err && err.message}`); throw err; });
          }
          return res;
        };
      },
    });
  }

  async _send(raw, jid, content, opts) {
    const messages = hot('messages');
    const sum = messages.summarizeContent(content);
    try {
      const res = await raw.sendMessage(jid, content, opts);
      if (res && res.key && res.key.id) { this.sentCache.set(res.key.id, res); this.sentIds.set(res.key.id, true); }
      const target = Array.isArray(jid) ? jid.join(',') : jid;
      const isGroup = typeof target === 'string' && target.endsWith('@g.us');
      this.logger.info({
        event: 'message.sent', jid: target, group: isGroup ? this.groupName(target) : undefined, id: res && res.key && res.key.id,
        content: sum, quotedId: opts && opts.quoted && opts.quoted.key && opts.quoted.key.id,
      }, `📤 ${sum.kind} → ${isGroup ? this.groupName(target) || target : target}${sum.text ? ': ' + U.truncate(sum.text, 80) : ''}`);
      hot('stats').recordOut(this, target);
      this.bus.emit('message.sent', { jid: target, content, result: res, summary: sum });
      return res;
    } catch (err) {
      this.logger.error({ event: 'message.send_failed', jid: Array.isArray(jid) ? jid.join(',') : jid, content: sum, err }, `Gagal mengirim ${sum.kind}: ${err.message}`);
      throw err;
    }
  }

  /* --------------------------------- pipeline event --------------------------------- */

  async _onEvent(name, payload) {
    if (name !== 'messages.upsert' && name !== 'creds.update' && name !== 'connection.update') {
      this._logEvent(name, payload);
    }
    this.bus.emit(`baileys:${name}`, payload);
    switch (name) {
      case 'connection.update': return this._onConnection(payload);
      case 'creds.update': return this._onCreds(payload);
      case 'messages.upsert': return this._onUpsert(payload);
      case 'messages.update': for (const u of payload || []) this.bus.emit('message.update', u); break;
      case 'messages.delete': this.bus.emit('message.delete', payload); break;
      case 'groups.upsert':
        for (const g of payload || []) hot('groups').put(this, g);
        this.bus.emit('group.metadata.update', { type: 'upsert', groups: payload });
        break;
      case 'groups.update':
        for (const u of payload || []) hot('groups').applyUpdate(this, u);
        this.bus.emit('group.metadata.update', { type: 'update', groups: payload });
        break;
      case 'group-participants.update':
        hot('groups').applyParticipants(this, payload);
        this.bus.emit('group.participants.update', payload);
        break;
      case 'contacts.upsert': case 'contacts.update':
        for (const c of payload || []) {
          const id = c.id || c.lid || c.phoneNumber;
          if (!id) continue;
          const k = U.normalizeJid(id);
          const cur = this.db.data.contacts[k] || (this.db.data.contacts[k] = { name: '', notify: '', seenAt: Date.now() });
          if (c.name) cur.name = c.name;
          if (c.notify) cur.notify = c.notify;
          if (c.verifiedName) cur.name = cur.name || c.verifiedName;
        }
        this.db.save();
        break;
      case 'chats.upsert':
        for (const c of payload || []) if (c.id) this.touchContact(c.id, c.name);
        break;
      case 'messaging-history.set':
        for (const c of (payload && payload.contacts) || []) {
          const id = c.id || c.lid;
          if (id) { const k = U.normalizeJid(id); this.db.data.contacts[k] = { ...(this.db.data.contacts[k] || { seenAt: Date.now() }), name: c.name || '', notify: c.notify || '' }; }
        }
        for (const c of (payload && payload.chats) || []) if (c.id) this.touchContact(c.id, c.name);
        this.db.save();
        break;
      default:
    }
  }

  _logEvent(name, payload) {
    let data;
    if (name === 'messaging-history.set') {
      data = { chats: (payload.chats || []).length, contacts: (payload.contacts || []).length, messages: (payload.messages || []).length, isLatest: payload.isLatest, syncType: payload.syncType };
    } else data = U.sanitize(payload, { maxDepth: 4, maxString: 300, maxArray: 15, maxKeys: 25 });
    const jid = payload && !Array.isArray(payload) && typeof payload.id === 'string' ? payload.id : undefined;
    const group = jid && jid.endsWith('@g.us') ? this.groupName(jid) || undefined : undefined;
    this.logger.info({ event: `baileys.${name}`, jid, group, data }, `Event ${name}`);
  }

  async _onCreds() {
    try {
      await this.saveCreds();
      this.logs.logger('auth').info({ event: 'credentials.update', registered: !!this.authState.creds.registered }, 'Kredensial diperbarui & disimpan (terenkripsi)');
      this.bus.emit('credentials.update', { registered: !!this.authState.creds.registered });
    } catch (err) {
      this.logs.logger('auth').error({ event: 'credentials.save_failed', err }, `Gagal menyimpan kredensial: ${err.message}`);
    }
  }

  async _onUpsert({ messages, type }) {
    const msgMod = hot('messages');
    for (const raw of messages || []) {
      try {
        if (!raw || !raw.key) continue;
        const id = raw.key.id;
        if (this.sentIds.has(id)) { this.logger.trace({ event: 'message.echo', id }, 'Echo pesan sendiri (sudah dicatat sebagai message.sent)'); continue; }
        const dup = this.seenIds.has(`${raw.key.remoteJid}|${id}`);
        this.seenIds.set(`${raw.key.remoteJid}|${id}`, true);
        const m = msgMod.build(this, raw, type);
        this._logIncoming(m, dup);
        if (dup) continue;
        if (m.pushName && !m.fromMe) this.touchContact(m.sender, m.pushName);
        if (m.pushName && !m.isGroup && !m.fromMe) this.touchContact(m.chat, m.pushName);
        if (!m.raw.message) continue;
        hot('stats').recordIn(this, m);
        this.bus.emit('message.received', { m, upsertType: type });
        const age = Date.now() - m.timestamp;
        if (m.isCommand && (type === 'notify' || type === 'append') && age < 60000 && m.timestamp >= this.startedAt - 15000) {
          await hot('router').handle(this, m);
        }
      } catch (err) {
        this.logger.error({ event: 'message.process_error', id: raw && raw.key && raw.key.id, err }, `Gagal memproses pesan: ${err.message}`);
      }
    }
  }

  _logIncoming(m, dup) {
    const textMax = this.config.get('logging.textMax');
    const media = m.media && { type: m.media.type, mimetype: m.media.mimetype, size: m.media.size, fileName: m.media.fileName || undefined, seconds: m.media.seconds || undefined };
    const gname = m.isGroup ? this.groupName(m.chat) : '';
    const who = m.fromMe ? 'BotNoi' : m.pushName || m.senderNumber;
    const preview = m.text ? U.truncate(m.text.replace(/\s+/g, ' '), 100) : m.media ? `[${m.media.type}]` : `[${m.type || 'kosong'}]`;
    this.logger.info({
      event: dup ? 'message.duplicate' : 'message.received',
      jid: m.chat, group: gname || undefined, id: m.id, sender: m.sender, senderNumber: m.senderNumber, pushName: m.pushName || undefined,
      fromMe: m.fromMe, isBotNoi: m.isBotNoi, upsertType: m.upsertType, type: m.type, text: m.text ? m.text.slice(0, textMax) : undefined,
      media, quotedId: m.quoted ? m.quoted.id : undefined, quotedType: m.quoted ? m.quoted.type : undefined, isCommand: m.isCommand,
      timestamp: m.timestamp,
    }, `📩 ${who}${gname ? ' @ ' + gname : m.isGroup ? ' @ grup' : ''}: ${preview}`);
  }

  /* ----------------------------------- koneksi ----------------------------------- */

  async _onConnection(update) {
    const { connection, lastDisconnect, qr, isNewLogin } = update;
    const clog = this.logs.logger('connection');
    clog.info({ event: 'connection.update', data: U.sanitize({ connection, qr: qr ? '<qr>' : undefined, isNewLogin, receivedPendingNotifications: update.receivedPendingNotifications, error: lastDisconnect && lastDisconnect.error }, { maxDepth: 3 }) }, `connection.update: ${connection || (qr ? 'qr' : Object.keys(update).join(','))}`);
    this.bus.emit('connection.update', update);

    if (qr) await this._onQr(qr);

    if (connection === 'connecting' && this.status !== 'reconnecting') this._setStatus('connecting');

    if (connection === 'open') {
      this.me = this.sock.user || (this.authState.creds && this.authState.creds.me) || null;
      this._refreshIds();
      this.connectedAt = Date.now();
      this.retries = 0;
      this.qr = null;
      this.pairingCode = null;
      this.info.registered = true;
      this.info.lastConnectedAt = new Date().toISOString();
      this.db.data.stats.connections.opened++;
      this.db.save();
      this._setStatus('open', { jid: this.botJid });
      clog.info({ event: 'connection.open', jid: this.botJid, name: this.me && this.me.name }, `✅ Tersambung sebagai ${this.botJid} (${(this.me && this.me.name) || '-'})`);
      this.manager.coreStore.save();
      this.plugins.broadcastConnected().catch(() => {});
      this._afterOpen(isNewLogin).catch((err) => clog.error({ event: 'connection.after_open_error', err }, err.message));
    }

    if (connection === 'close') await this._onClose(lastDisconnect);
  }

  _refreshIds() {
    const me = this.me || {};
    this.botIds = new Set();
    for (const j of [me.id, me.lid, me.phoneNumber, this.authState.creds.me && this.authState.creds.me.id, this.authState.creds.me && this.authState.creds.me.lid]) {
      if (j) this.botIds.add(U.normalizeJid(j));
    }
    this.botJid = U.normalizeJid(me.id || '');
    this.botLid = U.normalizeJid(me.lid || '');
    if (this.botJid && !this.info.phone) this.info.phone = U.jidUser(this.botJid);
  }

  async _afterOpen(isNewLogin) {
    if (this.config.get('auth.backupOnConnect') && !this.backedUpThisRun) {
      try { await this.backupAuth(isNewLogin ? 'new-login' : 'connect'); } catch (err) {
        this.logs.logger('auth').error({ event: 'auth.backup_failed', err }, `Backup otomatis gagal: ${err.message}`);
      }
    }
    try {
      const n = await hot('groups').refreshAll(this);
      this.logger.info({ event: 'groups.synced', count: n }, `Cache grup diperbarui: ${n} grup`);
    } catch (err) {
      this.logger.warn({ event: 'groups.sync_failed', err }, `Sinkron grup gagal: ${err.message}`);
    }
  }

  async backupAuth(reason = 'manual') {
    await this.saveCreds();
    const r = await backup.createBackup(this.name, this.authFolder, { reason, keep: this.config.get('auth.backupKeep') });
    if (reason === 'connect' || reason === 'new-login') this.backedUpThisRun = true;
    this.logs.logger('auth').info({ event: 'auth.backup', id: r.id, files: r.files, bytes: r.bytes, reason }, `Backup auth dibuat: ${r.id} (${r.files} file, ${U.formatBytes(r.bytes)})`);
    return r;
  }

  async _onQr(qr) {
    this.qr = qr;
    if (this.info.method === 'pairing') {
      if (this.pairingRequested || this.authState.creds.registered) return;
      const phone = String(this.info.phone || '').replace(/\D/g, '');
      if (!phone) { this.logger.error({ event: 'pairing.no_phone' }, 'Metode pairing tapi nomor belum diisi'); return; }
      this.pairingRequested = true;
      await U.sleep(this.config.get('connection.pairingDelayMs'));
      try {
        const code = await this.rawSock.requestPairingCode(phone);
        this.pairingCode = code;
        this.logs.logger('auth').info({ event: 'pairing.code', phone }, `🔗 Pairing code untuk ${this.name} (${phone}): ${code}`);
        this.emit('pairing', code);
        this.manager.emit('pairing', this.name, code, phone);
      } catch (err) {
        this.pairingRequested = false;
        this.logs.logger('auth').error({ event: 'pairing.failed', err }, `Gagal meminta pairing code: ${err.message}`);
      }
      return;
    }
    this.logs.logger('auth').info({ event: 'qr.generated' }, `QR baru untuk ${this.name} — scan dari WhatsApp > Perangkat tertaut`);
    this.emit('qr', qr);
    this.manager.emit('qr', this.name, qr);
  }

  async _onClose(lastDisconnect) {
    const bl = this.baileys;
    const err = lastDisconnect && lastDisconnect.error;
    const code = (err && err.output && err.output.statusCode) || (err && err.data && err.data.statusCode) || 0;
    const clog = this.logs.logger('connection');
    const was = this.connectedAt;
    this.connectedAt = 0;
    this.db.data.stats.connections.closed++;
    this.db.save();
    clog.warn({ event: 'connection.close', code, reason: err && err.message, uptimeMs: was ? Date.now() - was : 0 }, `🔌 Koneksi tertutup (code ${code || '?'}): ${err ? err.message : 'tanpa error'}`);
    this.plugins.broadcastDisconnected({ code, error: err && err.message }).catch(() => {});

    if (this.stopping) { this._setStatus('stopped'); return; }
    const DR = bl.DisconnectReason || {};
    if (code === DR.loggedOut) return this._onLoggedOut();
    if (code === DR.connectionReplaced) {
      this.lastError = 'koneksi digantikan sesi lain';
      this._teardownSocket();
      this._setStatus('replaced');
      clog.error({ event: 'connection.replaced' }, 'Sesi digantikan perangkat/instance lain — tidak reconnect otomatis');
      return;
    }
    const immediate = code === DR.restartRequired;
    this._scheduleReconnect(immediate ? 0 : undefined, err && err.message);
  }

  _scheduleReconnect(delay, reason) {
    const max = this.config.get('connection.reconnectMaxRetries');
    this.retries++;
    if (max > 0 && this.retries > max) {
      this.lastError = `reconnect gagal ${max}x`;
      this._teardownSocket();
      this._setStatus('failed');
      this.logs.logger('connection').fatal({ event: 'reconnect.giveup', retries: this.retries }, `Menyerah reconnect setelah ${max} percobaan`);
      return;
    }
    if (delay === undefined) {
      delay = Math.min(this.config.get('connection.reconnectMaxDelayMs'), this.config.get('connection.reconnectBaseDelayMs') * 2 ** Math.min(this.retries - 1, 10));
      delay += Math.floor(Math.random() * 500);
    }
    this._setStatus('reconnecting', { retries: this.retries, delay });
    this.db.data.stats.connections.reconnects++;
    this.db.save();
    this.logs.logger('connection').info({ event: 'reconnect.scheduled', retries: this.retries, delay, reason }, `♻️ Reconnect #${this.retries} dalam ${delay}ms`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      if (this.stopping) return;
      try {
        this._teardownSocket();
        await this._connect();
      } catch (err) {
        this.logs.logger('connection').error({ event: 'reconnect.error', err }, `Reconnect error: ${err.message}`);
        this._scheduleReconnect(undefined, err.message);
      }
    }, delay);
  }

  async _onLoggedOut() {
    this._teardownSocket();
    this.db.data.stats.connections.logouts++;
    this.db.save();
    this.info.registered = false;
    this.lastError = 'logout dari WhatsApp';
    this.logs.logger('connection').warn({ event: 'connection.logged_out' }, '🚪 Logout terdeteksi (perangkat dihapus dari WhatsApp). Sesi perlu login ulang.');
    if (this.config.get('auth.wipeOnLogout')) {
      cryptoAuth.wipeFolder(this.authFolder);
      this.logs.logger('auth').warn({ event: 'auth.wiped' }, 'Folder auth dibersihkan karena logout (backup lama tetap tersimpan)');
    }
    this._setStatus('logged_out');
    this.emit('logout');
    this.manager.emit('logout', this.name);
  }

  /* --------------------------------- stop / restart --------------------------------- */

  async stop(reason = 'manual') {
    if (this.status === 'stopped' && !this.rawSock) return;
    this.logger && this.logger.info({ event: 'session.stop', reason }, `Menghentikan sesi "${this.name}" (${reason})`);
    this.stopping = true;
    this._setStatus('stopping');
    clearTimeout(this.reconnectTimer);
    try { if (this.plugins) await this.plugins.stopAll(reason); } catch (err) { this.logger.error({ event: 'plugins.stop_error', err }, err.message); }
    if (this.authState && this.saveCreds) { try { await this.saveCreds(); } catch { /* ignore */ } }
    this._teardownSocket();
    this.sock = null;
    this.connectedAt = 0;
    this._setStatus('stopped');
    if (this.db) await this.db.flush();
    if (this.logs) await this.manager.logs.closeScope(this.name);
    await db.closeAccount(this.name);
    this.db = this.db; // referensi tetap untuk summary() yang aman
  }

  async restart() {
    await this.stop('restart');
    await U.sleep(500);
    this.db = null;
    await this.start();
  }

  /** Logout dari WhatsApp (menghapus perangkat) lalu hapus auth. */
  async logout() {
    if (this.status === 'open' && this.rawSock) {
      this.logger.warn({ event: 'session.logout' }, 'Logout dari WhatsApp diminta');
      try { await this.rawSock.logout(); } catch (err) { this.logger.warn({ event: 'session.logout_error', err }, err.message); }
    }
  }
}

module.exports = { Session, EVENTS };
