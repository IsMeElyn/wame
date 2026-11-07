'use strict';
/**
 * SessionManager — mengelola banyak akun dalam satu proses.
 * Tiap akun bisa start / stop / restart / dihapus sendiri-sendiri.
 */
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const U = require('./utils');
const db = require('./db');
const cryptoAuth = require('./crypto-auth');
const backup = require('./backup');
const { Session } = require('./session');
const { purgeModules } = require('./plugin-manager');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

class SessionManager extends EventEmitter {
  constructor({ config, logs, coreStore }) {
    super();
    this.config = config;
    this.logs = logs;
    this.coreStore = coreStore;
    this.sessions = new Map();
    this.watchers = [];
    this.log = logs.logger('core', 'manager');
    this.startedAt = Date.now();
  }

  names() { return Object.keys(this.coreStore.data.sessions).sort(); }
  has(name) { return !!this.coreStore.data.sessions[name]; }
  get(name) {
    const info = this.coreStore.data.sessions[name];
    if (!info) return null;
    let s = this.sessions.get(name);
    if (!s) { s = new Session(this, name, info); this.sessions.set(name, s); }
    return s;
  }
  running() { return [...this.sessions.values()].filter((s) => ['open', 'connecting', 'reconnecting', 'starting'].includes(s.status)); }

  list() {
    return this.names().map((n) => {
      const s = this.get(n);
      return { ...s.summary(), autoStart: s.info.autoStart !== false, auth: cryptoAuth.inspectFolder(s.authFolder), createdAt: s.info.createdAt };
    });
  }

  /* ------------------------------------- CRUD ------------------------------------- */

  create(rawName, { method = 'qr', phone = '', autoStart = true } = {}) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('nama sesi: 2-32 karakter, huruf kecil/angka/-/_, diawali huruf/angka');
    if (this.has(name)) throw new Error(`sesi "${name}" sudah ada`);
    if (name === 'core') throw new Error('nama "core" dicadangkan');
    if (!['qr', 'pairing'].includes(method)) throw new Error('metode harus qr atau pairing');
    const digits = String(phone || '').replace(/\D/g, '');
    if (method === 'pairing' && digits.length < 8) throw new Error('metode pairing butuh nomor lengkap dengan kode negara (mis. 628123456789)');
    this.coreStore.data.sessions[name] = { name, method, phone: digits || null, autoStart, createdAt: new Date().toISOString(), registered: false, lastStatus: 'stopped' };
    this.coreStore.save();
    this.log.info({ event: 'session.created', session: name, method }, `Sesi dibuat: ${name} (${method})`);
    return this.get(name);
  }

  setMethod(name, method, phone) {
    const s = this.get(name);
    if (!s) throw new Error('sesi tidak ada');
    if (!['qr', 'pairing'].includes(method)) throw new Error('metode harus qr atau pairing');
    const digits = String(phone || s.info.phone || '').replace(/\D/g, '');
    if (method === 'pairing' && digits.length < 8) throw new Error('pairing butuh nomor lengkap');
    s.info.method = method;
    if (digits) s.info.phone = digits;
    this.coreStore.save();
    this.log.info({ event: 'session.method', session: name, method }, `Metode sesi ${name} → ${method}`);
  }

  async start(name) {
    const s = this.get(name);
    if (!s) throw new Error(`sesi "${name}" tidak ada`);
    await s.start();
    return s;
  }
  async stop(name, reason) {
    const s = this.get(name);
    if (!s) throw new Error(`sesi "${name}" tidak ada`);
    await s.stop(reason);
  }
  async restart(name) {
    const s = this.get(name);
    if (!s) throw new Error(`sesi "${name}" tidak ada`);
    if (['stopped', 'logged_out', 'failed', 'replaced'].includes(s.status)) return s.start();
    await s.restart();
  }

  async startMany(names) {
    const out = [];
    for (const n of names) {
      try { await this.start(n); out.push({ name: n, ok: true }); } catch (err) { out.push({ name: n, ok: false, error: err.message }); }
    }
    return out;
  }

  /** Logout (bila tersambung) + hapus auth + database akun. Log & backup dipertahankan kecuali diminta. */
  async remove(name, { deleteLogs = false, deleteBackups = false } = {}) {
    const s = this.get(name);
    if (!s) throw new Error(`sesi "${name}" tidak ada`);
    if (s.status === 'open') {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 8000);
        s.once('logout', () => { clearTimeout(t); resolve(); });
        s.logout().catch(() => { clearTimeout(t); resolve(); });
      });
    }
    await s.stop('hapus sesi').catch(() => {});
    cryptoAuth.wipeFolder(s.authFolder);
    await db.deleteAccountDb(name);
    delete this.coreStore.data.sessions[name];
    this.sessions.delete(name);
    this.coreStore.save();
    if (deleteLogs) fs.rmSync(path.join(paths.LOGS, name), { recursive: true, force: true });
    if (deleteBackups) fs.rmSync(backup.dirFor(name), { recursive: true, force: true });
    this.log.warn({ event: 'session.removed', session: name, deleteLogs, deleteBackups }, `Sesi dihapus: ${name}`);
  }

  /** Restore auth dari backup. Sesi akan dihentikan dulu, lalu (opsional) dijalankan lagi. */
  async restoreAuth(name, backupId, { startAfter = false } = {}) {
    const s = this.get(name);
    if (!s) throw new Error(`sesi "${name}" tidak ada`);
    const wasRunning = !['stopped', 'logged_out', 'failed', 'replaced'].includes(s.status);
    if (wasRunning) await s.stop('restore auth');
    const r = await backup.restoreBackup(name, s.authFolder, backupId);
    this.log.warn({ event: 'auth.restored', session: name, backup: backupId, files: r.files }, `Auth ${name} di-restore dari ${backupId}`);
    if (startAfter || wasRunning) await s.start();
    return r;
  }

  async stopAll(reason = 'shutdown') {
    await Promise.all([...this.sessions.values()].map((s) => s.stop(reason).catch((err) => this.log.error({ event: 'session.stop_error', session: s.name, err }, err.message))));
  }

  async shutdown() {
    this.log.info({ event: 'core.shutdown' }, 'Shutdown: menghentikan semua sesi…');
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
    await this.stopAll('shutdown');
  }

  /* --------------------------------- hot reload plugin --------------------------------- */

  /** Muat ulang satu file plugin di SEMUA sesi yang berjalan. */
  async reloadPluginFile(file) {
    purgeModules();
    const results = {};
    for (const s of this.sessions.values()) {
      if (!s.plugins || ['stopped', 'stopping'].includes(s.status)) continue;
      if (fs.existsSync(file)) results[s.name] = await s.plugins.reloadFile(file, { purge: false });
      else { await s.plugins.unloadFile(file); results[s.name] = { ok: true, unloaded: true }; }
    }
    return results;
  }

  watchPlugins() {
    if (!this.config.get('plugins.hotReload')) return;
    const timers = new Map();
    const onChange = (dir, kind) => (evt, filename) => {
      if (!filename || !/\.js$/.test(filename) || filename.startsWith('.')) return;
      const file = path.join(dir, filename);
      clearTimeout(timers.get(file));
      timers.set(file, setTimeout(async () => {
        timers.delete(file);
        this.log.info({ event: 'hotreload.change', file: path.relative(paths.ROOT, file), kind }, `File berubah: ${path.relative(paths.ROOT, file)} — memuat ulang`);
        try {
          if (kind === 'lib') {
            purgeModules();
            for (const s of this.sessions.values()) {
              if (!s.plugins || ['stopped', 'stopping'].includes(s.status)) continue;
              for (const e of [...s.plugins.entries.values()]) if (e.def) await s.plugins.reloadFile(e.file, { purge: false });
            }
          } else await this.reloadPluginFile(file);
        } catch (err) { this.log.error({ event: 'hotreload.error', err }, err.message); }
      }, 400));
      if (timers.get(file).unref) timers.get(file).unref();
    };
    for (const [dir, kind] of [[paths.PLUGINS, 'plugin'], [paths.LIB, 'lib']]) {
      try {
        const w = fs.watch(dir, { persistent: false }, onChange(dir, kind));
        w.on('error', () => {});
        this.watchers.push(w);
      } catch (err) { this.log.warn({ event: 'hotreload.watch_failed', dir, err }, `Tidak bisa memantau ${dir}`); }
    }
    this.log.info({ event: 'hotreload.on' }, 'Hot reload plugin aktif (plugins/ & lib/)');
  }
}

module.exports = { SessionManager, NAME_RE };
