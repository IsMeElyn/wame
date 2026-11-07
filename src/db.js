'use strict';
/**
 * Lapisan LowDB (v7 itu ESM-only, jadi dimuat lewat import() dinamis — file kita tetap CommonJS).
 *
 *  data/db/core.json              -> pengaturan global + daftar sesi
 *  data/db/accounts/<nama>.json   -> pengaturan akun, kontak, grup, statistik, data plugin
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { deepFill, stamp } = require('./utils');

let mods = null;
async function lowdb() {
  if (!mods) {
    const a = await import('lowdb');
    const b = await import('lowdb/node');
    mods = { Low: a.Low, JSONFile: b.JSONFile };
  }
  return mods;
}

const CORE_DEFAULTS = {
  version: 1,
  settings: {}, // flat: "bot.prefix": "."
  sessions: {}, // nama -> { name, method, phone, autoStart, createdAt, ... }
};

const ACCOUNT_DEFAULTS = {
  meta: { createdAt: null },
  settings: {
    mode: null, // null = ikut bot.defaultMode
    commandsEnabled: true,
    disabledCommands: [],
    prefix: null, // null = ikut bot.prefix
    richEnabled: null, // null = ikut bot.richEnabled
  },
  plugins: {}, // nama -> { enabled, config:{} }
  pluginData: {}, // nama -> data bebas milik plugin
  contacts: {}, // jid -> { name, notify, seenAt }
  groups: {}, // jid -> metadata ringkas
  stats: {
    messagesReceived: 0,
    messagesSent: 0,
    commandsRun: 0,
    commandErrors: 0,
    commands: {},
    perChat: {},
    perDay: {},
    connections: { opened: 0, closed: 0, reconnects: 0, logouts: 0 },
    firstSeenAt: null,
  },
};

const open = new Map();

class Store {
  constructor(file, db, defaults) {
    this.file = file;
    this.db = db;
    this.defaults = defaults;
    this.dirty = false;
    this.timer = null;
    this.chain = Promise.resolve();
  }
  get data() { return this.db.data; }
  /** Jadwalkan penulisan (debounce). */
  save(delay = 300) {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delay);
    if (this.timer.unref) this.timer.unref();
  }
  /** Tulis sekarang & tunggu selesai. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    this.chain = this.chain
      .then(() => this.db.write())
      .catch((err) => { this.dirty = true; console.error(`[db] gagal menulis ${this.file}: ${err.message}`); });
    return this.chain;
  }
  /** Baca ulang dari disk (dipakai setelah restore). */
  async reload() {
    await this.chain;
    await this.db.read();
    this.db.data = deepFill(this.db.data || {}, this.defaults);
  }
}

async function openStore(file, defaults) {
  if (open.has(file)) return open.get(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { Low, JSONFile } = await lowdb();
  let db = new Low(new JSONFile(file), structuredClone(defaults));
  try {
    await db.read();
  } catch (err) {
    // JSON rusak -> karantina, mulai baru (tidak menghapus apa pun)
    const bad = `${file}.corrupt-${stamp()}`;
    try { fs.renameSync(file, bad); } catch { /* ignore */ }
    console.error(`[db] ${file} rusak (${err.message}); dipindah ke ${bad}`);
    db = new Low(new JSONFile(file), structuredClone(defaults));
  }
  db.data = deepFill(db.data || {}, defaults);
  const store = new Store(file, db, defaults);
  open.set(file, store);
  await db.write();
  return store;
}

const openCore = () => openStore(path.join(paths.DB, 'core.json'), CORE_DEFAULTS);
const accountFile = (name) => path.join(paths.ACCOUNT_DB, `${name}.json`);
async function openAccount(name) {
  const s = await openStore(accountFile(name), ACCOUNT_DEFAULTS);
  if (!s.data.meta.createdAt) { s.data.meta.createdAt = new Date().toISOString(); s.save(); }
  return s;
}
async function closeStore(file) {
  const s = open.get(file);
  if (!s) return;
  await s.flush();
  open.delete(file);
}
const closeAccount = (name) => closeStore(accountFile(name));
async function deleteAccountDb(name) {
  await closeAccount(name);
  try { fs.unlinkSync(accountFile(name)); } catch { /* sudah tidak ada */ }
}
async function flushAll() {
  await Promise.all([...open.values()].map((s) => s.flush()));
}

/* ------------------------------ backup / restore database ------------------------------ */

const dbBackupRoot = () => path.join(paths.BACKUPS, '_db');

async function backupDatabases(label = 'manual', keep = 10) {
  await flushAll();
  const id = `${stamp()}_${String(label).replace(/[^a-z0-9_-]/gi, '')}`;
  const dest = path.join(dbBackupRoot(), id);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(paths.DB, dest, { recursive: true, filter: (src) => !src.includes('.corrupt-') && !src.endsWith('.tmp') });
  const all = listDatabaseBackups();
  for (const old of all.slice(keep)) fs.rmSync(path.join(dbBackupRoot(), old.id), { recursive: true, force: true });
  return { id, dir: dest };
}
function listDatabaseBackups() {
  const root = dbBackupRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: path.join(root, d.name), mtime: fs.statSync(path.join(root, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? 1 : -1));
}
async function restoreDatabases(id) {
  const src = path.join(dbBackupRoot(), id);
  if (!fs.existsSync(src)) throw new Error(`backup database "${id}" tidak ditemukan`);
  await backupDatabases('pre-restore', 20);
  fs.cpSync(src, paths.DB, { recursive: true, force: true });
  for (const s of open.values()) await s.reload();
  return { id };
}

module.exports = {
  openStore, openCore, openAccount, closeAccount, closeStore, deleteAccountDb, flushAll, accountFile,
  backupDatabases, listDatabaseBackups, restoreDatabases, CORE_DEFAULTS, ACCOUNT_DEFAULTS,
};
