'use strict';
/**
 * Sistem log: Pino -> stream kustom -> file LowDB terstruktur, PER SESI LOG.
 *
 *  data/logs/<scope>/<YYYY-MM-DD_HH-mm-ss>.json        (scope = nama akun atau "core")
 *  data/logs/<scope>/<...>.p2.json, .p3.json           (part lanjutan bila entri sangat banyak)
 *
 * Setiap start/restart sebuah scope membuka sesi log BARU bernama sesuai tahun-bulan-tanggal_jam-menit-detik.
 * Bentuk entri:
 *  { seq, time, level, scope, source, event, msg, jid, group, data }
 *   - source: core | connection | auth | session | message | group | cli | plugin:<nama> | baileys | monitor ...
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const paths = require('./paths');
const db = require('./db');
const U = require('./utils');

const LEVEL_NAME = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 100 };
const COLORS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', fatal: '\x1b[41m\x1b[97m' };
const RESET = '\x1b[0m';
const FILE_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?)(?:\.p(\d+))?\.json$/;
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;

function idToDate(id) {
  const m = String(id).match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

class ScopeLog {
  constructor(center, scope) {
    this.center = center;
    this.config = center.config;
    this.scope = scope;
    this.dir = path.join(paths.LOGS, scope);
    this.id = null;
    this.part = 1;
    this.store = null;
    this.buffer = [];
    this.seq = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.closed = false;
    this.startedAt = Date.now();
    this.counters = { total: 0, byLevel: {}, bySource: {}, messagesIn: 0, messagesOut: 0, commands: 0 };
    this.root = null;
  }

  async open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const base = U.stamp(new Date(this.startedAt));
    let id = base;
    for (let n = 2; fs.existsSync(path.join(this.dir, `${id}.json`)); n++) id = `${base}-${n}`;
    this.id = id;
    await this._openPart(1);
    const self = this;
    this.root = pino(
      {
        level: 'trace',
        base: { scope: this.scope },
        timestamp: pino.stdTimeFunctions.isoTime,
        serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
        hooks: {
          // `this` = instance logger (root/child) -> harus function biasa, bukan arrow
          logMethod(args, method) {
            if (args.length && args[0] && typeof args[0] === 'object' && !(args[0] instanceof Error)) {
              args[0] = U.sanitize(args[0], { maxString: self.config.get('logging.textMax'), maxDepth: 6, maxArray: 60, maxKeys: 60 });
            }
            return method.apply(this, args);
          },
        },
      },
      { write: (line) => this._onLine(line) }
    );
    this.logger('log').info({ event: 'log.session.start', logSession: this.id }, `Sesi log baru: ${this.scope}/${this.id}`);
  }

  async _openPart(n) {
    const file = path.join(this.dir, n === 1 ? `${this.id}.json` : `${this.id}.p${n}.json`);
    this.part = n;
    this.store = await db.openStore(file, { meta: {}, entries: [] });
    const m = this.store.data.meta;
    if (!m.sessionId) {
      Object.assign(m, {
        scope: this.scope, sessionId: this.id, part: n, startedAt: new Date(this.startedAt).toISOString(), endedAt: null,
        pid: process.pid, node: process.version, platform: `${process.platform}/${process.arch}`,
      });
      this.store.dirty = true;
    }
  }

  /** Logger Pino turunan untuk sebuah sumber. */
  logger(source = 'core', bindings = {}, level) {
    return this.root.child({ source, ...bindings }, level ? { level } : undefined);
  }

  _onLine(line) {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const { level, time, msg, scope, source, event, jid, group, ...rest } = o;
    const lvl = LEVEL_NAME[level] || 'info';
    const entry = {
      seq: ++this.seq,
      time: time || new Date().toISOString(),
      level: lvl,
      scope: this.scope,
      source: source || 'core',
    };
    if (event) entry.event = event;
    if (msg !== undefined) entry.msg = msg;
    if (jid) entry.jid = jid;
    if (group) entry.group = group;
    if (Object.keys(rest).length) entry.data = rest;

    const c = this.counters;
    c.total++;
    c.byLevel[lvl] = (c.byLevel[lvl] || 0) + 1;
    c.bySource[entry.source] = (c.bySource[entry.source] || 0) + 1;
    if (event === 'message.received') c.messagesIn++;
    else if (event === 'message.sent') c.messagesOut++;
    else if (event === 'command.executed') c.commands++;

    this.buffer.push(entry);
    this._console(entry, level);
    if (this.buffer.length >= 200) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.config.get('logging.flushMs'));
      if (this.timer.unref) this.timer.unref();
    }
  }

  _console(e, levelNum) {
    if (levelNum < (LEVEL_NUM[this.config.get('logging.consoleLevel')] ?? 30)) return;
    const t = U.formatTime(e.time);
    const lv = e.level.toUpperCase().padEnd(5);
    const text = e.msg !== undefined ? e.msg : e.event || '';
    const tag = `[${e.scope}/${e.source}]`;
    const line = useColor
      ? `\x1b[90m${t}${RESET} ${COLORS[e.level]}${lv}${RESET} \x1b[90m${tag}${RESET} ${text}`
      : `${t} ${lv} ${tag} ${text}`;
    process.stdout.write(line + '\n');
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain = this.chain.then(() => this._flush()).catch((e) => console.error('[log] flush gagal:', e.message));
    return this.chain;
  }

  async _flush() {
    if (!this.buffer.length) return;
    const batch = this.buffer.splice(0);
    const d = this.store.data;
    for (const e of batch) d.entries.push(e);
    d.meta.count = d.entries.length;
    this.store.dirty = true;
    await this.store.flush();
    if (d.entries.length >= this.config.get('logging.maxEntriesPerFile')) {
      const old = this.store;
      await this._openPart(this.part + 1);
      await db.closeStore(old.file);
    }
  }

  /** Penulisan sinkron untuk saat proses keluar mendadak. */
  flushSync() {
    try {
      if (this.timer) clearTimeout(this.timer);
      const d = this.store.data;
      for (const e of this.buffer.splice(0)) d.entries.push(e);
      d.meta.count = d.entries.length;
      fs.writeFileSync(this.store.file, JSON.stringify(d));
    } catch { /* best effort */ }
  }

  /** Semua file part sesi ini, urut. */
  partFiles() {
    return this.center._partFiles(this.scope, this.id).map((p) => p.file);
  }

  /** Hapus isi sesi log aktif (entri lama hilang; kejadian reset dicatat di sesi yang sama). */
  async reset(by = 'system') {
    await this.flush();
    for (const p of this.center._partFiles(this.scope, this.id)) {
      if (p.part !== this.part) fs.rmSync(p.file, { force: true });
    }
    const removed = this.counters.total;
    this.buffer = [];
    this.store.data.entries = [];
    this.store.data.meta.count = 0;
    this.store.data.meta.resetAt = new Date().toISOString();
    this.store.dirty = true;
    await this.store.flush();
    this.counters = { total: 0, byLevel: {}, bySource: {}, messagesIn: 0, messagesOut: 0, commands: 0 };
    this.logger('log').warn({ event: 'log.reset', by, removed }, `Log sesi ini di-reset oleh ${by} (${removed} entri dihapus)`);
    await this.flush();
    return removed;
  }

  async close() {
    if (this.closed) return;
    this.logger('log').info({ event: 'log.session.end', logSession: this.id, total: this.counters.total }, `Sesi log ditutup: ${this.scope}/${this.id}`);
    await this.flush();
    this.closed = true;
    this.store.data.meta.endedAt = new Date().toISOString();
    this.store.dirty = true;
    await this.store.flush();
    await db.closeStore(this.store.file);
  }
}

class LogCenter {
  constructor(config) {
    this.config = config;
    this.scopes = new Map();
  }

  /** Membuka sesi log BARU untuk scope (menutup yang lama bila ada). */
  async openScope(scope) {
    const prev = this.scopes.get(scope);
    if (prev) await prev.close();
    const s = new ScopeLog(this, scope);
    await s.open();
    this.scopes.set(scope, s);
    return s;
  }
  get(scope) { return this.scopes.get(scope) || null; }
  logger(scope, source, bindings) {
    const s = this.scopes.get(scope);
    if (!s) throw new Error(`scope log "${scope}" belum dibuka`);
    return s.logger(source, bindings);
  }
  async closeScope(scope) {
    const s = this.scopes.get(scope);
    if (!s) return;
    await s.close();
    this.scopes.delete(scope);
  }
  async flushAll() { await Promise.all([...this.scopes.values()].map((s) => s.flush())); }
  async shutdown() {
    for (const scope of [...this.scopes.keys()]) await this.closeScope(scope);
  }
  flushSync() { for (const s of this.scopes.values()) s.flushSync(); }

  /* --------------------------------- membaca --------------------------------- */

  _partFiles(scope, id) {
    const dir = path.join(paths.LOGS, scope);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(FILE_RE);
      if (m && m[1] === id) out.push({ file: path.join(dir, f), part: m[2] ? Number(m[2]) : 1 });
    }
    return out.sort((a, b) => a.part - b.part);
  }

  /** Daftar sesi log (terbaru dulu). */
  listSessions(scope) {
    const dir = path.join(paths.LOGS, scope);
    if (!fs.existsSync(dir)) return [];
    const map = new Map();
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(FILE_RE);
      if (!m) continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      const s = map.get(m[1]) || { id: m[1], files: [], size: 0, startedAt: idToDate(m[1]), updatedAt: 0 };
      s.files.push(full);
      s.size += st.size;
      s.updatedAt = Math.max(s.updatedAt, st.mtimeMs);
      map.set(m[1], s);
    }
    const active = this.scopes.get(scope);
    const list = [...map.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
    for (const s of list) {
      s.active = !!active && active.id === s.id;
      s.count = s.active ? active.counters.total : this._countCached(s);
    }
    return list;
  }

  _countCached(s) {
    this._cc = this._cc || new Map();
    const key = `${s.id}:${s.size}:${s.updatedAt}`;
    if (this._cc.has(key)) return this._cc.get(key);
    let n = 0;
    for (const f of s.files) {
      try { n += JSON.parse(fs.readFileSync(f, 'utf8')).entries.length; } catch { /* ignore */ }
    }
    this._cc.set(key, n);
    return n;
  }

  /** Baca seluruh entri sebuah sesi (id | 'latest'). */
  async readSession(scope, id = 'latest') {
    const active = this.scopes.get(scope);
    if (id === 'latest' || (active && id === active.id)) {
      if (active) {
        await active.flush();
        return this._readFiles(this._partFiles(scope, active.id).map((p) => p.file), active);
      }
      const l = this.listSessions(scope)[0];
      if (!l) return { meta: null, entries: [] };
      return this._readFiles(l.files);
    }
    const parts = this._partFiles(scope, id);
    if (!parts.length) return { meta: null, entries: [] };
    return this._readFiles(parts.map((p) => p.file));
  }

  _readFiles(files, active) {
    let meta = null;
    const entries = [];
    for (const f of files) {
      try {
        // bagian aktif dibaca dari memori (paling mutakhir)
        const d = active && active.store.file === f ? active.store.data : JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!meta) meta = d.meta;
        for (const e of d.entries) entries.push(e);
      } catch { /* part rusak dilewati */ }
    }
    return { meta, entries };
  }

  /**
   * Query entri. opts: { session, limit=50, level (exact), minLevel, q, jid, jids[], source, event, deep }
   * @returns entri urut kronologis (terlama -> terbaru), diambil `limit` terakhir.
   */
  async query(scope, opts = {}) {
    const { entries } = await this.readSession(scope, opts.session || 'latest');
    const q = opts.q ? String(opts.q).toLowerCase() : '';
    const min = opts.minLevel ? LEVEL_NUM[opts.minLevel] : 0;
    const jids = opts.jids ? new Set(opts.jids) : null;
    const out = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (opts.level && e.level !== opts.level) continue;
      if (min && LEVEL_NUM[e.level] < min) continue;
      if (opts.source && !String(e.source).startsWith(opts.source)) continue;
      if (opts.event && e.event !== opts.event) continue;
      if (opts.jid && e.jid !== opts.jid) continue;
      if (q || jids) {
        let hit = false;
        if (jids && e.jid && jids.has(e.jid)) hit = true;
        if (!hit && q) {
          const hay = `${e.msg || ''} ${e.event || ''} ${e.source || ''} ${e.group || ''} ${e.jid || ''}`.toLowerCase();
          hit = hay.includes(q) || (opts.deep && e.data && JSON.stringify(e.data).toLowerCase().includes(q));
        }
        if (!hit) continue;
      }
      out.push(e);
      if (out.length >= (opts.limit || 50)) break;
    }
    return out.reverse();
  }

  /** Ringkasan sesi log (level, sumber, pesan). Untuk sesi aktif memakai counter memori. */
  async summary(scope, id = 'latest') {
    const active = this.scopes.get(scope);
    if (active && (id === 'latest' || id === active.id)) {
      return { id: active.id, active: true, ...structuredClone(active.counters), startedAt: active.startedAt };
    }
    const { meta, entries } = await this.readSession(scope, id);
    const s = { id: meta && meta.sessionId, active: false, total: entries.length, byLevel: {}, bySource: {}, messagesIn: 0, messagesOut: 0, commands: 0 };
    for (const e of entries) {
      s.byLevel[e.level] = (s.byLevel[e.level] || 0) + 1;
      s.bySource[e.source] = (s.bySource[e.source] || 0) + 1;
      if (e.event === 'message.received') s.messagesIn++;
      else if (e.event === 'message.sent') s.messagesOut++;
      else if (e.event === 'command.executed') s.commands++;
    }
    return s;
  }

  deleteSession(scope, id) {
    const active = this.scopes.get(scope);
    if (active && active.id === id) throw new Error('sesi log aktif tidak bisa dihapus — gunakan reset');
    const parts = this._partFiles(scope, id);
    if (!parts.length) throw new Error(`sesi log "${id}" tidak ditemukan`);
    for (const p of parts) fs.rmSync(p.file, { force: true });
    return parts.length;
  }

  /** Gabungkan sesi (semua part) menjadi satu file JSON di folder tmp untuk dikirim/diekspor. */
  async exportSession(scope, id = 'latest') {
    const { meta, entries } = await this.readSession(scope, id);
    if (!meta) throw new Error('sesi log tidak ditemukan');
    fs.mkdirSync(paths.TMP, { recursive: true });
    const file = path.join(paths.TMP, `log-${scope}-${meta.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({ meta, entries }, null, 2));
    return file;
  }
}

module.exports = { LogCenter, LEVEL_NUM, LEVEL_NAME, idToDate };
