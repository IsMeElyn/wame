'use strict';
/**
 * Membangun `ctx` untuk satu plugin:
 *  ctx.sock ctx.sendMessage ctx.send ctx.logger ctx.config ctx.database ctx.events ctx.auth ctx.utils ctx.plugins
 *  + ctx.groups ctx.timers ctx.state ctx.sendRich ctx.sendInteractive ctx.canRun ctx.session
 */
const path = require('path');
const paths = require('./paths');
const U = require('./utils');
const hot = require('./hot');
const backup = require('./backup');

const RESERVED_EVENTS = new Set(['error']);

function toSource(src) {
  if (typeof src === 'string') return { url: src };
  return src; // Buffer | {url} | {stream}
}

function build(session, entry, pm) {
  const name = entry.name;
  const logger = session.logs.logger(`plugin:${name}`);
  const disposers = new Set();
  const listeners = [];
  const timers = new Set();

  /* ---------------------------- events (ter-scope + cleanup) ---------------------------- */
  const bus = session.bus;
  const wrap = (evt, fn) => (payload) => { pm.invoke(entry, `event:${evt}`, () => fn(payload)); };
  const events = {
    on(evt, fn) {
      if (RESERVED_EVENTS.has(evt)) throw new Error(`nama event "${evt}" dicadangkan`);
      const w = wrap(evt, fn);
      bus.on(evt, w);
      listeners.push({ evt, w, fn });
      return () => events.off(evt, fn);
    },
    once(evt, fn) {
      const off = events.on(evt, (p) => { off(); return fn(p); });
      return off;
    },
    off(evt, fn) {
      const i = listeners.findIndex((l) => l.evt === evt && l.fn === fn);
      if (i >= 0) { bus.off(evt, listeners[i].w); listeners.splice(i, 1); }
    },
    emit(evt, data) {
      if (RESERVED_EVENTS.has(evt)) throw new Error(`nama event "${evt}" dicadangkan`);
      return bus.emit(evt, data);
    },
    listenerCount: () => listeners.length,
    names: () => [...new Set(listeners.map((l) => l.evt))],
  };
  disposers.add(() => { for (const l of listeners.splice(0)) bus.off(l.evt, l.w); });

  /* ----------------------------------- timers ----------------------------------- */
  const timersApi = {
    setTimeout(fn, ms) { const t = setTimeout(() => { timers.delete(t); pm.invoke(entry, 'timeout', fn); }, ms); timers.add(t); return t; },
    setInterval(fn, ms) { const t = setInterval(() => pm.invoke(entry, 'interval', fn), ms); timers.add(t); return t; },
    clear(t) { clearTimeout(t); clearInterval(t); timers.delete(t); },
  };
  disposers.add(() => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); });

  /* ------------------------------------ config ------------------------------------ */
  const config = {
    get: (key, def) => { const v = pm.getConfig(entry)[key]; return v === undefined ? def : v; },
    all: () => pm.getConfig(entry),
    set: (key, value) => pm.setConfig(entry, key, value),
    reset: (key) => pm.resetConfig(entry, key),
    core: {
      get: (p) => session.manager.config.get(p),
      set: (p, v) => session.manager.config.set(p, v),
      all: () => session.manager.config.all(),
    },
  };

  /* ---------------------------------- database ---------------------------------- */
  const data = () => session.db.data.pluginData[name] || (session.db.data.pluginData[name] = {});
  const database = {
    get: (key, def) => U.getPath(data(), key, def),
    set: (key, value) => { U.setPath(data(), key, value); session.db.save(); return value; },
    has: (key) => U.getPath(data(), key, undefined) !== undefined,
    delete: (key) => { const parts = key.split('.'); const last = parts.pop(); const o = parts.length ? U.getPath(data(), parts.join('.')) : data(); if (o) delete o[last]; session.db.save(); },
    update: (key, fn, def) => { const v = fn(U.getPath(data(), key, def)); U.setPath(data(), key, v); session.db.save(); return v; },
    all: () => data(),
    get raw() { return data(); },
    save: () => session.db.save(),
    flush: () => session.db.flush(),
    clear: () => { session.db.data.pluginData[name] = {}; session.db.save(); },
  };

  /* ------------------------------------ kirim ------------------------------------ */
  const sock = () => session.sock;
  const sendMessage = (jid, content, opts) => sock().sendMessage(jid, content, opts);
  const keyOf = (x) => (x && x.key ? x.key : x);
  const send = {
    text: (jid, text, opts) => sendMessage(jid, { text }, opts),
    image: (jid, source, caption, opts) => sendMessage(jid, { image: toSource(source), caption }, opts),
    video: (jid, source, caption, opts = {}) => sendMessage(jid, { video: toSource(source), caption, gifPlayback: !!opts.gif }, opts),
    audio: (jid, source, { ptt = false } = {}, opts) => sendMessage(jid, { audio: toSource(source), ptt, mimetype: ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg' }, opts),
    document: (jid, source, { fileName = 'file', mimetype = 'application/octet-stream', caption } = {}, opts) => sendMessage(jid, { document: toSource(source), fileName, mimetype, caption }, opts),
    location: (jid, lat, lon, locName, opts) => sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lon, name: locName } }, opts),
    quoted: (jid, content, quotedMsg, opts = {}) => sendMessage(jid, typeof content === 'string' ? { text: content } : content, { ...opts, quoted: quotedMsg.raw || quotedMsg }),
    reply: (m, content, opts = {}) => sendMessage(m.chat, typeof content === 'string' ? { text: content } : content, { ...opts, quoted: m.raw || m }),
    react: (m, emoji) => sendMessage(m.chat || m.key.remoteJid, { react: { key: keyOf(m), text: emoji } }),
    edit: (jid, key, text) => sendMessage(jid, { text, edit: key }),
    /** Hapus pesan (hanya pesan bot sendiri / bila bot admin grup). Tidak melempar error. */
    async delete(m) {
      const key = keyOf(m);
      try { await sendMessage(key.remoteJid, { delete: key }); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
    },
  };

  async function sendRich(jid, template, vars = {}, opts = {}) {
    const bl = session.baileys;
    const richMod = hot('rich');
    const out = richMod.render(template, { botName: session.manager.config.get('bot.name'), ...vars }, {
      disclaimer: vars.disclaimer || session.manager.config.get('bot.name'),
      tokenize: bl.tokenizeCode,
    });
    if (!session.richEnabled()) return sendMessage(jid, { text: out.text }, opts);
    try {
      return await sendMessage(jid, out.content, opts);
    } catch (err) {
      logger.warn({ event: 'rich.fallback', template, err }, `Rich Message "${template}" gagal, kirim teks biasa: ${err.message}`);
      return sendMessage(jid, { text: out.text }, opts);
    }
  }

  async function sendInteractive(jid, content, opts = {}) {
    try {
      return await sendMessage(jid, content, opts);
    } catch (err) {
      logger.warn({ event: 'interactive.fallback', err }, `Interactive gagal, kirim teks: ${err.message}`);
      const lines = [content.text || content.caption || ''];
      for (const b of content.nativeFlow || content.buttons || []) {
        if (b.sections) for (const s of b.sections) for (const r of s.rows) lines.push(`• ${r.title} → ${r.id}`);
        else if (b.id) lines.push(`• ${b.text} → ${b.id}`);
      }
      if (content.footer) lines.push(`_${content.footer}_`);
      return sendMessage(jid, { text: lines.join('\n') }, opts);
    }
  }

  /* ------------------------------------- grup ------------------------------------- */
  const G = () => hot('groups');
  const groups = {
    list: () => G().list(session),
    find: (q) => G().find(session, q),
    metadata: (jid, o) => G().get(session, jid, o),
    refresh: (jid) => (jid ? G().refresh(session, jid) : G().refreshAll(session)),
    members: async (jid, o) => G().memberRows(session, await G().get(session, jid, o)),
    admins: async (jid, o) => G().admins(session, await G().get(session, jid, o)),
    info: async (jid, o) => { const g = await G().get(session, jid, o); return { name: g.subject, description: g.desc, size: g.size, creation: g.creation }; },
    participant: async (jid, user) => {
      const rows = G().memberRows(session, await G().get(session, jid));
      const n = U.jidUser(user);
      return rows.find((r) => U.jidUser(r.jid) === n || r.number === n) || null;
    },
    isAdmin: async (jid, user) => { const p = await groups.participant(jid, user); return !!(p && p.isAdmin); },
    name: (jid) => G().name(session, jid),
  };

  /* ------------------------------------- auth ------------------------------------- */
  const auth = {
    get status() { return session.status; },
    get registered() { return !!(session.authState && session.authState.creds && session.authState.creds.registered); },
    get me() { return session.me; },
    get botJid() { return session.botJid; },
    get method() { return session.info.method; },
    get phone() { return session.info.phone; },
    get connectedAt() { return session.connectedAt; },
    isBotNoi: (jid) => session.isBotNoi(jid),
    backup: (reason = 'plugin') => session.backupAuth(reason),
    backups: () => backup.listBackups(session.name),
    get lastBackup() { return backup.listBackups(session.name)[0] || null; },
  };

  /* ------------------------------------ plugins ------------------------------------ */
  const plugins = {
    list: () => pm.status(),
    get: (n) => pm.status().find((p) => p.name === n) || null,
    has: (n) => pm.entries.has(n),
    status: (n) => (pm.entries.get(n) || {}).state || 'missing',
    isEnabled: (n) => pm.isEnabled(n),
    commands: () => pm.listCommands(),
    enable: (n) => pm.enable(n),
    disable: (n) => pm.disable(n),
    reload: (n) => pm.reload(n),
    start: (n) => pm.start(n),
    stop: (n) => pm.stop(n),
    manager: pm,
  };

  /* ------------------------------------- utils ------------------------------------- */
  const utils = {
    ...U,
    tmpFile: (ext = '') => path.join(paths.TMP, `${name}-${U.randomId(5)}${ext.startsWith('.') || !ext ? ext : '.' + ext}`),
    tmpDir: paths.TMP,
    rich: { render: (tpl, vars, o) => hot('rich').render(tpl, vars, o), list: () => hot('rich').list() },
  };

  const ctx = {
    name,
    version: entry.def.version,
    plugin: { name, version: entry.def.version, file: entry.file },
    get sock() { return sock(); },
    sendMessage,
    send,
    sendRich,
    sendInteractive,
    logger,
    config,
    database,
    events,
    auth,
    utils,
    plugins,
    groups,
    timers: timersApi,
    state: {}, // scratch per-instance (jangan simpan state di level modul — modul dipakai bersama semua akun)
    session: {
      get name() { return session.name; },
      get status() { return session.status; },
      get prefix() { return session.getPrefix(); },
      get mode() { return session.getMode(); },
      get uptimeMs() { return session.connectedAt ? Date.now() - session.connectedAt : 0; },
      stats: () => session.db.data.stats,
      settings: () => session.db.data.settings,
      logs: session.manager.logs, // LogCenter (query/summary/listSessions/get(scope))
      manager: session.manager,
      raw: session,
    },
    getMessageInfo: (m) => hot('messages').info(m),
    getSentMessage: (id) => session.sentCache.get(id) || null,
    canRun: (m, cmd) => hot('router').canRun(session, m, cmd),
    _dispose: () => { for (const d of disposers) d(); disposers.clear(); },
    _stats: () => ({ events: listeners.length, timers: timers.size }),
  };
  return ctx;
}

module.exports = { build };
