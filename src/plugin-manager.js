'use strict';
/**
 * PluginManager — satu instance per Session (akun).
 *
 * Lifecycle: register -> load(validate) -> [cek dependensi] -> start -> (onConnected/onDisconnected)* -> stop -> unload
 * State    : loaded | starting | running | stopping | stopped | disabled | blocked | failed
 *
 * Definisi plugin (module.exports):
 *   { name, version, description, author, dependencies:{nama:'>=1.0.0'}, config:{defaults,schema},
 *     commands:[{name,aliases,description,usage,category,ownerOnly,groupOnly,privateOnly,control,run(ctx,m,args)}],
 *     events:{'message.received'(ctx,payload){}}, start(ctx), stop(ctx), onConnected(ctx), onDisconnected(ctx,info) }
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const U = require('./utils');
const semver = require('./semver');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const CMD_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;
const KNOWN_KEYS = new Set(['name', 'version', 'description', 'author', 'dependencies', 'config', 'commands', 'events', 'start', 'stop', 'onConnected', 'onDisconnected', 'category', 'default']);

/** Hapus cache require untuk plugins/ dan lib/ (BUKAN src/) supaya perubahan file terbaca. */
function purgeModules() {
  let n = 0;
  for (const f of Object.keys(require.cache)) {
    if (f.startsWith(paths.PLUGINS + path.sep) || f.startsWith(paths.LIB + path.sep)) { delete require.cache[f]; n++; }
  }
  return n;
}

function validate(def) {
  const errors = [];
  const warnings = [];
  if (!def || typeof def !== 'object') return { errors: ['export bukan object'], warnings };
  if (typeof def.name !== 'string' || !NAME_RE.test(def.name)) errors.push('`name` wajib, huruf kecil/angka/-/_ (2-40 karakter)');
  if (typeof def.version !== 'string' || !semver.valid(def.version)) errors.push('`version` wajib berformat semver (mis. 1.0.0)');
  if (def.description !== undefined && typeof def.description !== 'string') errors.push('`description` harus string');
  if (def.dependencies !== undefined) {
    if (Array.isArray(def.dependencies)) { if (!def.dependencies.every((d) => typeof d === 'string')) errors.push('`dependencies` array harus berisi string'); }
    else if (def.dependencies && typeof def.dependencies === 'object') {
      for (const [k, v] of Object.entries(def.dependencies)) if (typeof v !== 'string') errors.push(`dependensi "${k}" harus string rentang versi`);
    } else errors.push('`dependencies` harus object {nama: rentangVersi} atau array nama');
  }
  if (def.config !== undefined && (typeof def.config !== 'object' || def.config === null)) errors.push('`config` harus object');
  if (def.commands !== undefined) {
    if (!Array.isArray(def.commands)) errors.push('`commands` harus array');
    else {
      const seen = new Set();
      def.commands.forEach((c, i) => {
        if (!c || typeof c !== 'object') return errors.push(`commands[${i}] bukan object`);
        if (typeof c.name !== 'string' || !CMD_RE.test(c.name)) errors.push(`commands[${i}].name tidak valid`);
        if (typeof c.run !== 'function') errors.push(`commands[${i}].run harus function`);
        if (c.aliases !== undefined && (!Array.isArray(c.aliases) || !c.aliases.every((a) => typeof a === 'string' && CMD_RE.test(a)))) errors.push(`commands[${i}].aliases tidak valid`);
        for (const n of [c.name, ...(c.aliases || [])]) {
          if (seen.has(n)) errors.push(`nama command ganda dalam plugin: ${n}`);
          seen.add(n);
        }
      });
    }
  }
  if (def.events !== undefined) {
    if (!def.events || typeof def.events !== 'object') errors.push('`events` harus object');
    else for (const [k, v] of Object.entries(def.events)) if (typeof v !== 'function') errors.push(`events["${k}"] harus function`);
  }
  for (const k of ['start', 'stop', 'onConnected', 'onDisconnected']) if (def[k] !== undefined && typeof def[k] !== 'function') errors.push(`\`${k}\` harus function`);
  for (const k of Object.keys(def || {})) if (!KNOWN_KEYS.has(k)) warnings.push(`properti tidak dikenal: ${k}`);
  return { errors, warnings };
}

const depsOf = (def) => (Array.isArray(def.dependencies) ? Object.fromEntries(def.dependencies.map((d) => [d, '*'])) : def.dependencies || {});

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} melewati batas waktu ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

class PluginManager {
  constructor(session) {
    this.session = session;
    this.entries = new Map(); // name -> entry
    this.commandMap = new Map(); // nama/alias -> { entry, cmd }
    this.log = session.logs.logger('plugins');
  }

  get cfg() { return this.session.manager.config; }
  get db() { return this.session.db; }
  record(name) {
    const p = this.db.data.plugins;
    return p[name] || (p[name] = { enabled: null, config: {} });
  }
  isEnabled(name) { return this.record(name).enabled !== false; }

  /* ------------------------------- register / load ------------------------------- */

  listFiles() {
    if (!fs.existsSync(paths.PLUGINS)) return [];
    const out = [];
    for (const f of fs.readdirSync(paths.PLUGINS, { withFileTypes: true })) {
      if (f.name.startsWith('_') || f.name.startsWith('.')) continue;
      if (f.isFile() && f.name.endsWith('.js')) out.push(path.join(paths.PLUGINS, f.name));
      else if (f.isDirectory() && fs.existsSync(path.join(paths.PLUGINS, f.name, 'index.js'))) out.push(path.join(paths.PLUGINS, f.name, 'index.js'));
    }
    return out.sort();
  }

  /** Muat semua plugin dari folder (register + validasi), tanpa menjalankan. */
  scan() {
    for (const f of this.listFiles()) this.register(f);
    return this.entries.size;
  }

  _require(file) {
    const mod = require(file);
    return mod && mod.default && typeof mod.default === 'object' ? mod.default : mod;
  }

  /** @returns {{ok:boolean, entry?:object, error?:string}} */
  register(file) {
    const base = path.basename(file, '.js');
    let def;
    try { def = this._require(file); } catch (err) {
      return this._failedEntry(base, file, `gagal memuat: ${err.message}`, err);
    }
    const { errors, warnings } = validate(def);
    if (errors.length) return this._failedEntry(def && def.name ? def.name : base, file, `struktur tidak valid: ${errors.join('; ')}`);
    const existing = this.entries.get(def.name);
    if (existing && existing.file !== file) {
      this.log.error({ event: 'plugin.duplicate', plugin: def.name, file, existing: existing.file }, `Plugin duplikat "${def.name}" ditolak (${path.basename(file)} vs ${path.basename(existing.file)})`);
      return this._failedEntry(`${def.name}#dup-${base}`, file, `nama plugin duplikat dengan ${path.basename(existing.file)}`);
    }
    const entry = {
      name: def.name, file, base, def, state: 'loaded', error: null, warnings,
      loadedAt: Date.now(), startedAt: null, stoppedAt: null,
      errorCount: 0, consecutiveErrors: 0, lastError: null, lastErrorAt: null,
      ctx: null, commands: [], calls: 0,
    };
    this.entries.set(def.name, entry);
    this.log.info({ event: 'plugin.registered', plugin: def.name, version: def.version, warnings }, `Plugin terdaftar: ${def.name}@${def.version}`);
    return { ok: true, entry };
  }

  _failedEntry(name, file, reason, err) {
    const entry = {
      name, file, base: path.basename(file, '.js'), def: null, state: 'failed', error: reason, warnings: [],
      loadedAt: Date.now(), startedAt: null, stoppedAt: null, errorCount: 1, consecutiveErrors: 0,
      lastError: reason, lastErrorAt: Date.now(), ctx: null, commands: [], calls: 0,
    };
    this.entries.set(name, entry);
    this.log.error({ event: 'plugin.load_failed', plugin: name, file, reason, err }, `Plugin gagal dimuat: ${name} — ${reason}`);
    return { ok: false, entry, error: reason };
  }

  /* --------------------------------- lifecycle --------------------------------- */

  _order() {
    const names = [...this.entries.values()].filter((e) => e.def).map((e) => e.name);
    const visited = new Map();
    const out = [];
    const visit = (n, trail) => {
      if (visited.get(n) === 2) return;
      if (visited.get(n) === 1) { this._cycle = [...trail, n]; return; }
      visited.set(n, 1);
      const e = this.entries.get(n);
      for (const d of Object.keys(depsOf(e.def))) if (this.entries.get(d) && this.entries.get(d).def) visit(d, [...trail, n]);
      visited.set(n, 2);
      out.push(n);
    };
    this._cycle = null;
    for (const n of names) visit(n, []);
    return out;
  }

  async startAll() {
    for (const name of this._order()) {
      const e = this.entries.get(name);
      if (e.state === 'loaded' || e.state === 'stopped' || e.state === 'blocked') await this.start(name);
    }
    return this.status();
  }

  _checkDeps(entry) {
    for (const [dep, range] of Object.entries(depsOf(entry.def))) {
      const d = this.entries.get(dep);
      if (!d || !d.def) return `dependensi tidak ditemukan: ${dep}`;
      if (!semver.satisfies(d.def.version, range)) return `dependensi ${dep}@${d.def.version} tidak memenuhi ${range}`;
      if (d.state !== 'running') return `dependensi ${dep} belum berjalan (${d.state})`;
    }
    if (this._cycle && this._cycle.includes(entry.name)) return `siklus dependensi: ${this._cycle.join(' -> ')}`;
    return null;
  }

  async start(name) {
    const entry = this.entries.get(name);
    if (!entry || !entry.def) return { ok: false, error: 'plugin tidak ada / gagal dimuat' };
    if (entry.state === 'running') return { ok: true };
    if (!this.isEnabled(name)) { entry.state = 'disabled'; return { ok: false, error: 'plugin nonaktif' }; }
    this._order();
    const depErr = this._checkDeps(entry);
    if (depErr) {
      entry.state = 'blocked';
      entry.error = depErr;
      this.log.warn({ event: 'plugin.blocked', plugin: name, reason: depErr }, `Plugin ${name} tertahan: ${depErr}`);
      return { ok: false, error: depErr };
    }
    entry.state = 'starting';
    entry.error = null;
    const ctx = require('./context').build(this.session, entry, this);
    entry.ctx = ctx;
    const r = await this.invoke(entry, 'start', () => entry.def.start && entry.def.start(ctx), { timeoutMs: this.cfg.get('plugins.hookTimeoutMs') });
    if (!r.ok) {
      this._cleanup(entry);
      entry.state = 'failed';
      entry.error = `start gagal: ${r.error.message}`;
      return { ok: false, error: entry.error };
    }
    for (const [evt, fn] of Object.entries(entry.def.events || {})) ctx.events.on(evt, (payload) => fn(ctx, payload));
    this._registerCommands(entry);
    entry.state = 'running';
    entry.startedAt = Date.now();
    entry.consecutiveErrors = 0;
    this.log.info({ event: 'plugin.started', plugin: name, version: entry.def.version, commands: entry.commands.map((c) => c.name) }, `Plugin berjalan: ${name}@${entry.def.version}`);
    this.session.bus.emit('plugin.started', { name });
    if (this.session.status === 'open' && entry.def.onConnected) {
      await this.invoke(entry, 'onConnected', () => entry.def.onConnected(ctx), { timeoutMs: this.cfg.get('plugins.hookTimeoutMs') });
    }
    // plugin lain yang menunggu dependensi ini
    for (const other of this.entries.values()) {
      if (other.state === 'blocked' && Object.keys(depsOf(other.def || {})).includes(name)) await this.start(other.name);
    }
    return { ok: true };
  }

  async stop(name, { reason = 'manual', final = false } = {}) {
    const entry = this.entries.get(name);
    if (!entry || !entry.def) return { ok: false, error: 'plugin tidak ada' };
    if (entry.state !== 'running' && entry.state !== 'starting') return { ok: true };
    // hentikan dulu yang bergantung padanya
    for (const other of this.entries.values()) {
      if (other.state === 'running' && Object.keys(depsOf(other.def)).includes(name)) {
        await this.stop(other.name, { reason: `dependensi ${name} berhenti`, final });
        if (!final) { other.state = 'blocked'; other.error = `dependensi ${name} berhenti`; }
      }
    }
    entry.state = 'stopping';
    if (entry.def.stop) await this.invoke(entry, 'stop', () => entry.def.stop(entry.ctx), { timeoutMs: this.cfg.get('plugins.hookTimeoutMs') });
    this._cleanup(entry);
    entry.state = 'stopped';
    entry.stoppedAt = Date.now();
    this.log.info({ event: 'plugin.stopped', plugin: name, reason }, `Plugin berhenti: ${name} (${reason})`);
    this.session.bus.emit('plugin.stopped', { name });
    return { ok: true };
  }

  async stopAll(reason = 'shutdown') {
    const order = this._order().reverse();
    for (const n of order) await this.stop(n, { reason, final: true });
  }

  /** Bersihkan listener event, timer, dan registrasi command milik plugin. */
  _cleanup(entry) {
    if (entry.ctx && entry.ctx._dispose) {
      try { entry.ctx._dispose(); } catch (err) { this.log.warn({ event: 'plugin.cleanup_error', plugin: entry.name, err }, `cleanup ${entry.name} bermasalah`); }
    }
    for (const [k, v] of this.commandMap) if (v.entry === entry) this.commandMap.delete(k);
    entry.commands = [];
    entry.ctx = null;
  }

  _registerCommands(entry) {
    for (const cmd of entry.def.commands || []) {
      const names = [cmd.name, ...(cmd.aliases || [])];
      const ok = [];
      for (const n of names) {
        const ex = this.commandMap.get(n);
        if (ex && ex.entry !== entry) {
          this.log.error({ event: 'plugin.command_conflict', plugin: entry.name, command: n, owner: ex.entry.name }, `Command "${n}" dari ${entry.name} bentrok dengan ${ex.entry.name} — dilewati`);
          continue;
        }
        this.commandMap.set(n, { entry, cmd });
        ok.push(n);
      }
      if (ok.length) entry.commands.push({ ...cmd, registered: ok });
    }
  }

  async enable(name) {
    if (!this.entries.has(name)) return { ok: false, error: 'plugin tidak ada' };
    this.record(name).enabled = true;
    this.db.save();
    this.log.info({ event: 'plugin.enabled', plugin: name }, `Plugin diaktifkan: ${name}`);
    const e = this.entries.get(name);
    if (e.state === 'disabled' || e.state === 'stopped' || e.state === 'blocked' || e.state === 'loaded') return this.start(name);
    return { ok: true };
  }

  async disable(name) {
    const e = this.entries.get(name);
    if (!e) return { ok: false, error: 'plugin tidak ada' };
    this.record(name).enabled = false;
    this.db.save();
    await this.stop(name, { reason: 'dinonaktifkan' });
    e.state = 'disabled';
    this.log.info({ event: 'plugin.disabled', plugin: name }, `Plugin dinonaktifkan: ${name}`);
    return { ok: true };
  }

  /**
   * Muat ulang satu file plugin tanpa restart. Versi baru divalidasi dulu; bila gagal, versi lama tetap berjalan.
   * @param {string} file path absolut
   * @param {{purge?:boolean}} opts purge=false bila cache sudah dibersihkan oleh pemanggil (broadcast multi-akun)
   */
  async reloadFile(file, { purge = true } = {}) {
    if (purge) purgeModules();
    const old = [...this.entries.values()].find((e) => e.file === file && e.def);
    let def;
    try { def = this._require(file); } catch (err) {
      this.log.error({ event: 'plugin.reload_failed', file, err }, `Reload gagal (${path.basename(file)}): ${err.message}`);
      return { ok: false, error: err.message, kept: !!old };
    }
    const { errors } = validate(def);
    if (errors.length) {
      this.log.error({ event: 'plugin.reload_failed', file, errors }, `Reload ditolak (${path.basename(file)}): ${errors.join('; ')}`);
      return { ok: false, error: errors.join('; '), kept: !!old };
    }
    if (old) await this.stop(old.name, { reason: 'reload' });
    for (const [k, e] of this.entries) if (e.file === file) this.entries.delete(k);
    const r = this.register(file);
    if (!r.ok) return { ok: false, error: r.error };
    this.log.info({ event: 'plugin.reloaded', plugin: r.entry.name, version: r.entry.def.version }, `Plugin dimuat ulang: ${r.entry.name}@${r.entry.def.version}`);
    if (this.isEnabled(r.entry.name)) await this.start(r.entry.name);
    else r.entry.state = 'disabled';
    // dependen yang ikut berhenti perlu dijalankan lagi
    for (const e of this.entries.values()) if (e.state === 'blocked') await this.start(e.name);
    return { ok: true, name: r.entry.name, state: r.entry.state, error: r.entry.error };
  }

  async reload(name) {
    const e = this.entries.get(name);
    if (!e) return { ok: false, error: 'plugin tidak ada' };
    return this.reloadFile(e.file);
  }

  async unloadFile(file) {
    for (const [k, e] of [...this.entries]) {
      if (e.file !== file) continue;
      if (e.def) await this.stop(e.name, { reason: 'file dihapus' });
      this.entries.delete(k);
      this.log.warn({ event: 'plugin.unloaded', plugin: e.name }, `Plugin di-unload (file dihapus): ${e.name}`);
    }
  }

  /** Scan ulang folder: plugin baru ditambahkan & dijalankan. */
  async rescan() {
    const known = new Set([...this.entries.values()].map((e) => e.file));
    const added = [];
    for (const f of this.listFiles()) {
      if (known.has(f)) continue;
      const r = this.register(f);
      if (r.ok) { added.push(r.entry.name); if (this.isEnabled(r.entry.name)) await this.start(r.entry.name); }
    }
    return added;
  }

  async broadcastConnected() {
    for (const e of this.entries.values()) {
      if (e.state === 'running' && e.def.onConnected) {
        await this.invoke(e, 'onConnected', () => e.def.onConnected(e.ctx), { timeoutMs: this.cfg.get('plugins.hookTimeoutMs') });
      }
    }
  }
  async broadcastDisconnected(info) {
    for (const e of this.entries.values()) {
      if (e.state === 'running' && e.def.onDisconnected) {
        await this.invoke(e, 'onDisconnected', () => e.def.onDisconnected(e.ctx, info), { timeoutMs: this.cfg.get('plugins.hookTimeoutMs') });
      }
    }
  }

  /* --------------------------- eksekusi terisolasi --------------------------- */

  /**
   * Jalankan kode plugin dengan try/catch (+ timeout opsional). Error plugin TIDAK pernah menjatuhkan core.
   * @returns {Promise<{ok:boolean, value?:any, error?:Error}>}
   */
  async invoke(entry, label, fn, { timeoutMs = 0 } = {}) {
    entry.calls++;
    try {
      let p = Promise.resolve().then(fn);
      if (timeoutMs) p = withTimeout(p, timeoutMs, `${entry.name}.${label}`);
      const value = await p;
      entry.consecutiveErrors = 0;
      return { ok: true, value };
    } catch (err) {
      entry.errorCount++;
      entry.consecutiveErrors++;
      entry.lastError = `${label}: ${err && err.message}`;
      entry.lastErrorAt = Date.now();
      this.log.error({ event: 'plugin.error', plugin: entry.name, hook: label, err }, `Error di plugin ${entry.name} (${label}): ${err && err.message}`);
      const max = this.cfg.get('plugins.maxConsecutiveErrors');
      if (entry.consecutiveErrors >= max && entry.state === 'running') {
        this.log.fatal({ event: 'plugin.auto_stopped', plugin: entry.name, errors: entry.consecutiveErrors }, `Plugin ${entry.name} dihentikan otomatis: ${entry.consecutiveErrors} error beruntun`);
        this.stop(entry.name, { reason: 'terlalu banyak error' }).then(() => { entry.state = 'failed'; entry.error = 'dihentikan otomatis (error beruntun)'; });
      }
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /* ------------------------------- konfigurasi ------------------------------- */

  getConfig(entry) {
    const defaults = (entry.def.config && entry.def.config.defaults) || {};
    return { ...structuredClone(defaults), ...structuredClone(this.record(entry.name).config || {}) };
  }

  setConfig(entry, key, value) {
    const schema = (entry.def.config && entry.def.config.schema && entry.def.config.schema[key]) || null;
    const defaults = (entry.def.config && entry.def.config.defaults) || {};
    if (!(key in defaults) && !schema) return { ok: false, error: `key konfigurasi tidak dikenal: ${key}` };
    let v = value;
    const type = schema ? schema.type : typeof defaults[key];
    if (type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) return { ok: false, error: `${key} harus angka` };
      if (schema && schema.min !== undefined && v < schema.min) return { ok: false, error: `${key} minimal ${schema.min}` };
      if (schema && schema.max !== undefined && v > schema.max) return { ok: false, error: `${key} maksimal ${schema.max}` };
    } else if (type === 'boolean') {
      if (typeof v === 'string') v = /^(1|true|on|ya|yes)$/i.test(v) ? true : /^(0|false|off|no|tidak)$/i.test(v) ? false : v;
      if (typeof v !== 'boolean') return { ok: false, error: `${key} harus on/off` };
    } else if (type === 'enum') {
      if (!schema.values.includes(String(v))) return { ok: false, error: `${key} harus salah satu: ${schema.values.join(', ')}` };
      v = String(v);
    } else v = String(v);
    this.record(entry.name).config[key] = v;
    this.db.save();
    this.log.info({ event: 'plugin.config', plugin: entry.name, key, value: v }, `Konfigurasi plugin ${entry.name}.${key} = ${v}`);
    return { ok: true, value: v };
  }

  resetConfig(entry, key) {
    const c = this.record(entry.name).config;
    if (key) delete c[key]; else this.record(entry.name).config = {};
    this.db.save();
  }

  /* --------------------------------- query --------------------------------- */

  findCommand(name) {
    const hit = this.commandMap.get(name);
    return hit && hit.entry.state === 'running' ? hit : null;
  }

  listCommands() {
    const out = [];
    for (const e of this.entries.values()) {
      if (e.state !== 'running') continue;
      for (const c of e.commands) out.push({ name: c.name, aliases: c.aliases || [], description: c.description || '', usage: c.usage || '', category: c.category || (e.def.category || e.name), plugin: e.name, ownerOnly: !!c.ownerOnly, groupOnly: !!c.groupOnly, privateOnly: !!c.privateOnly, control: !!c.control });
    }
    return out;
  }

  get(name) { return this.entries.get(name) || null; }

  status() {
    return [...this.entries.values()].map((e) => ({
      name: e.name,
      version: e.def ? e.def.version : '-',
      description: e.def ? e.def.description || '' : '',
      state: e.state,
      enabled: this.isEnabled(e.name),
      file: path.basename(e.file),
      commands: e.commands.length,
      dependencies: e.def ? Object.entries(depsOf(e.def)).map(([k, v]) => `${k}${v === '*' ? '' : '@' + v}`) : [],
      errors: e.errorCount,
      lastError: e.lastError,
      lastErrorAt: e.lastErrorAt,
      error: e.error,
      uptimeMs: e.state === 'running' && e.startedAt ? Date.now() - e.startedAt : 0,
      listeners: e.ctx && e.ctx._stats ? e.ctx._stats() : { events: 0, timers: 0 },
      calls: e.calls,
    })).sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

module.exports = { PluginManager, validate, purgeModules, semver };
