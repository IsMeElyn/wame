'use strict';
const { getPath, setPath } = require('./utils');

/**
 * Konfigurasi Core.
 * Prioritas nilai:  ENV  >  pengaturan tersimpan (LowDB core.json)  >  default di bawah.
 * Setiap key divalidasi lewat SCHEMA. Nilai tidak valid di-skip + dicatat sebagai warning.
 */
const DEFAULTS = {
  bot: {
    name: 'WaBot',
    prefix: '.',
    defaultMode: 'private', // private = hanya BotNoi, public = semua orang
    cooldownMs: 1500, // jeda antar command per pengguna (tidak berlaku untuk BotNoi)
    richEnabled: true, // false = Rich Message diganti teks biasa
  },
  connection: {
    browserName: 'Chrome',
    markOnline: false,
    syncFullHistory: false,
    reconnectBaseDelayMs: 2000,
    reconnectMaxDelayMs: 60000,
    reconnectMaxRetries: 0, // 0 = tak terbatas
    pairingDelayMs: 1500,
  },
  auth: {
    backupOnConnect: true, // backup otomatis saat pertama kali tersambung
    backupKeep: 10,
    wipeOnLogout: true,
  },
  plugins: {
    hotReload: true,
    hookTimeoutMs: 15000,
    maxConsecutiveErrors: 25,
  },
  logging: {
    consoleLevel: 'info',
    baileysLevel: 'info', // log internal Baileys (trace = sangat besar)
    flushMs: 1500,
    maxEntriesPerFile: 3000, // lewat ini -> pecah ke file part berikutnya (tetap satu sesi)
    textMax: 4000, // panjang maksimum teks chat yang dicatat
  },
  monitor: {
    intervalMs: 60000, // snapshot resource ke log
  },
  status: {
    audience: 'contacts', // contacts | self (penerima status WhatsApp dari .sw)
  },
};

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const SCHEMA = {
  'bot.name': { type: 'string', min: 1, max: 40 },
  'bot.prefix': { type: 'string', min: 1, max: 3 },
  'bot.defaultMode': { type: 'enum', values: ['private', 'public'] },
  'bot.cooldownMs': { type: 'number', min: 0, max: 600000 },
  'bot.richEnabled': { type: 'boolean' },
  'connection.browserName': { type: 'string', min: 1, max: 30 },
  'connection.markOnline': { type: 'boolean' },
  'connection.syncFullHistory': { type: 'boolean' },
  'connection.reconnectBaseDelayMs': { type: 'number', min: 200, max: 600000 },
  'connection.reconnectMaxDelayMs': { type: 'number', min: 1000, max: 3600000 },
  'connection.reconnectMaxRetries': { type: 'number', min: 0, max: 100000 },
  'connection.pairingDelayMs': { type: 'number', min: 0, max: 60000 },
  'auth.backupOnConnect': { type: 'boolean' },
  'auth.backupKeep': { type: 'number', min: 1, max: 200 },
  'auth.wipeOnLogout': { type: 'boolean' },
  'plugins.hotReload': { type: 'boolean' },
  'plugins.hookTimeoutMs': { type: 'number', min: 1000, max: 600000 },
  'plugins.maxConsecutiveErrors': { type: 'number', min: 1, max: 100000 },
  'logging.consoleLevel': { type: 'enum', values: LEVELS },
  'logging.baileysLevel': { type: 'enum', values: LEVELS },
  'logging.flushMs': { type: 'number', min: 200, max: 60000 },
  'logging.maxEntriesPerFile': { type: 'number', min: 200, max: 100000 },
  'logging.textMax': { type: 'number', min: 100, max: 100000 },
  'monitor.intervalMs': { type: 'number', min: 5000, max: 3600000 },
  'status.audience': { type: 'enum', values: ['contacts', 'self'] },
};

/** ENV -> key konfigurasi */
const ENV_MAP = {
  BOT_NAME: 'bot.name',
  BOT_PREFIX: 'bot.prefix',
  BOT_MODE: 'bot.defaultMode',
  LOG_CONSOLE_LEVEL: 'logging.consoleLevel',
  LOG_BAILEYS_LEVEL: 'logging.baileysLevel',
  BOT_BACKUP_ON_CONNECT: 'auth.backupOnConnect',
  BOT_HOT_RELOAD: 'plugins.hotReload',
};

function validate(path, raw) {
  const rule = SCHEMA[path];
  if (!rule) return { ok: false, error: `key tidak dikenal: ${path}` };
  let v = raw;
  if (rule.type === 'boolean') {
    if (typeof v === 'string') {
      if (/^(1|true|on|yes|ya)$/i.test(v)) v = true;
      else if (/^(0|false|off|no|tidak)$/i.test(v)) v = false;
    }
    if (typeof v !== 'boolean') return { ok: false, error: `${path} harus boolean (on/off)` };
  } else if (rule.type === 'number') {
    v = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `${path} harus angka` };
    if (rule.min !== undefined && v < rule.min) return { ok: false, error: `${path} minimal ${rule.min}` };
    if (rule.max !== undefined && v > rule.max) return { ok: false, error: `${path} maksimal ${rule.max}` };
  } else if (rule.type === 'enum') {
    v = String(v).toLowerCase();
    if (!rule.values.includes(v)) return { ok: false, error: `${path} harus salah satu: ${rule.values.join(', ')}` };
  } else if (rule.type === 'string') {
    v = String(v);
    if (rule.min !== undefined && v.length < rule.min) return { ok: false, error: `${path} minimal ${rule.min} karakter` };
    if (rule.max !== undefined && v.length > rule.max) return { ok: false, error: `${path} maksimal ${rule.max} karakter` };
  }
  return { ok: true, value: v };
}

class Config {
  constructor() {
    this.store = null; // LowDB store core.json, field `settings` (flat: "a.b": value)
    this.env = {};
    this.warnings = [];
    for (const [envKey, path] of Object.entries(ENV_MAP)) {
      if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
        const r = validate(path, process.env[envKey]);
        if (r.ok) this.env[path] = r.value;
        else this.warnings.push(`ENV ${envKey}: ${r.error}`);
      }
    }
  }

  attach(store) {
    this.store = store;
    const s = store.data.settings || (store.data.settings = {});
    for (const k of Object.keys(s)) {
      const r = validate(k, s[k]);
      if (!r.ok) {
        this.warnings.push(`Pengaturan tersimpan diabaikan (${r.error})`);
        delete s[k];
      } else s[k] = r.value;
    }
  }

  get defaults() { return DEFAULTS; }
  get schema() { return SCHEMA; }
  keys() { return Object.keys(SCHEMA); }

  get(path) {
    if (path in this.env) return this.env[path];
    const stored = this.store && this.store.data.settings ? this.store.data.settings[path] : undefined;
    if (stored !== undefined) return stored;
    return getPath(DEFAULTS, path);
  }

  /** @returns {{ok:boolean, value?:any, error?:string, locked?:boolean}} */
  set(path, value) {
    const r = validate(path, value);
    if (!r.ok) return r;
    if (path in this.env) return { ok: false, error: `${path} dikunci oleh environment variable`, locked: true };
    if (!this.store) return { ok: false, error: 'store belum siap' };
    this.store.data.settings[path] = r.value;
    this.store.save();
    return { ok: true, value: r.value };
  }

  reset(path) {
    if (this.store && this.store.data.settings) delete this.store.data.settings[path];
    if (this.store) this.store.save();
  }

  /** Salinan nested seluruh konfigurasi efektif. */
  all() {
    const out = structuredClone(DEFAULTS);
    for (const k of this.keys()) setPath(out, k, this.get(k));
    return out;
  }

  isLocked(path) { return path in this.env; }
}

module.exports = { Config, DEFAULTS, SCHEMA, LEVELS, validate };
