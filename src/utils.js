'use strict';
const crypto = require('crypto');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, '0');

/** Stempel waktu lokal untuk nama file/sesi log: 2026-11-05_14-02-33 */
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;
}
function formatDate(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function formatTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function formatDateTime(ts) {
  return `${formatDate(ts)} ${formatTime(ts)}`;
}
function formatBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n >= 100 ? 0 : 1)} ${u[i]}`;
}
function formatDuration(ms) {
  ms = Math.max(0, Math.floor(Number(ms) || 0));
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}h`);
  if (h) parts.push(`${h}j`);
  if (m) parts.push(`${m}m`);
  if (!parts.length || sec) parts.push(`${sec}d`);
  return parts.join(' ');
}
function truncate(str, max = 80) {
  str = String(str ?? '');
  return str.length > max ? str.slice(0, Math.max(0, max - 1)) + '…' : str;
}
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Hapus suffix device/agent: 6281:12@s.whatsapp.net -> 6281@s.whatsapp.net */
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0];
  return `${user}@${jid.slice(at + 1)}`;
}
function jidUser(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0];
}
function jidNumber(jid) {
  const u = jidUser(jid);
  return /^\d+$/.test(u) ? u : u;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
/** Isi key yang belum ada dari defaults (tanpa menimpa nilai yang sudah ada). */
function deepFill(target, defaults) {
  if (!isPlainObject(target)) return structuredClone(defaults);
  for (const k of Object.keys(defaults)) {
    if (!(k in target) || target[k] === undefined) target[k] = structuredClone(defaults[k]);
    else if (isPlainObject(defaults[k]) && isPlainObject(target[k])) deepFill(target[k], defaults[k]);
  }
  return target;
}
function getPath(obj, path, def) {
  let cur = obj;
  for (const p of String(path).split('.')) {
    if (cur == null) return def;
    cur = cur[p];
  }
  return cur === undefined ? def : cur;
}
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Ubah nilai apa pun menjadi struktur JSON aman & ringkas untuk log:
 * Buffer -> "<bytes:N>", Long -> number, circular -> "[Circular]", dll.
 */
function sanitize(value, opts = {}, depth = 0, seen = new WeakSet()) {
  const { maxDepth = 5, maxString = 1000, maxArray = 30, maxKeys = 50 } = opts;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return value.length > maxString ? value.slice(0, maxString) + `…(+${value.length - maxString})` : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'function') return `[fn ${value.name || 'anonymous'}]`;
  if (t === 'symbol') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<bytes:${value.length}>`;
  if (value instanceof ArrayBuffer) return `<arraybuffer:${value.byteLength}>`;
  if (value instanceof Error) {
    return { type: value.name, message: value.message, stack: String(value.stack || '').split('\n').slice(0, 6).join('\n'), ...(value.output ? { statusCode: value.output.statusCode } : {}) };
  }
  if (typeof value.toNumber === 'function' && 'low' in value && 'high' in value) {
    try { return value.toNumber(); } catch { return `${value.low}:${value.high}`; }
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= maxDepth) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  seen.add(value);
  if (value instanceof Map) return sanitize(Object.fromEntries(value), opts, depth, seen);
  if (value instanceof Set) return sanitize([...value], opts, depth, seen);
  if (Array.isArray(value)) {
    const out = value.slice(0, maxArray).map((v) => sanitize(v, opts, depth + 1, seen));
    if (value.length > maxArray) out.push(`…(+${value.length - maxArray} item)`);
    return out;
  }
  const out = {};
  let n = 0;
  for (const k of Object.keys(value)) {
    if (n++ >= maxKeys) { out['…'] = `+${Object.keys(value).length - maxKeys} key`; break; }
    out[k] = sanitize(value[k], opts, depth + 1, seen);
  }
  return out;
}

/** Semaphore bernama (untuk membatasi proses berat, mis. ffmpeg) — hidup di core, tidak ikut hot-reload. */
const semaphores = new Map();
function semaphore(name, limit = 1) {
  let s = semaphores.get(name);
  if (!s) {
    s = { limit, active: 0, queue: [] };
    semaphores.set(name, s);
  }
  s.limit = limit;
  return {
    get waiting() { return s.queue.length; },
    get active() { return s.active; },
    async run(fn) {
      if (s.active >= s.limit) await new Promise((r) => s.queue.push(r));
      s.active++;
      try { return await fn(); } finally {
        s.active--;
        const next = s.queue.shift();
        if (next) next();
      }
    },
  };
}

/** Cek keberadaan binary di PATH. */
function hasBinary(cmd, args = ['-version']) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
}

/** LRU kecil berbasis Map. */
class LRU {
  constructor(max = 500) { this.max = max; this.map = new Map(); }
  has(k) { return this.map.has(k); }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return this;
  }
  delete(k) { return this.map.delete(k); }
  get size() { return this.map.size; }
}

/** Parser argumen: `a "b c" --flag --k=v` -> { _: [...], flags: {...} } */
function parseArgs(str) {
  const out = { _: [], flags: {} };
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) {
    const tok = m[1] ?? m[2] ?? m[3];
    if (m[3] && tok.startsWith('--')) {
      const [k, v] = tok.slice(2).split('=');
      out.flags[k] = v === undefined ? true : v;
    } else out._.push(tok);
  }
  return out;
}

module.exports = {
  sleep, pad2, stamp, formatDate, formatTime, formatDateTime, formatBytes, formatDuration, truncate, chunk,
  randomId, normalizeJid, jidUser, jidNumber, isPlainObject, deepFill, getPath, setPath, sanitize,
  semaphore, hasBinary, LRU, parseArgs,
};
