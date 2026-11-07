'use strict';
/**
 * useEncryptedMultiFileAuthState — pengganti useMultiFileAuthState bawaan Baileys.
 *
 * Perbedaan dengan versi standar:
 *  1. Setiap file auth dienkripsi AES-256-GCM (iv acak per tulis, tag integritas, AAD = nama logis file).
 *  2. Nama file disamarkan: HMAC-SHA256(namaLogis) -> "<hex>.wbx". Tidak ada creds.json / pre-key-1.json.
 *  3. Format file proprietary ("WBX1" + iv + tag + ciphertext), bukan JSON.
 *  => useMultiFileAuthState standar (Baileys original / fork lain) tidak bisa membaca folder ini,
 *     dan folder auth biasa tidak otomatis terbaca di sini.
 *
 * Kunci diturunkan (scrypt) dari AUTH_SECRET (env) atau data/.secret (dibuat otomatis, chmod 600) + PEPPER di kode.
 * Menulis memakai file sementara + rename (atomic) dan mutex per-file, sehingga aman dari file setengah-tertulis.
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');

const MAGIC = Buffer.from('WBX1');
const PEPPER = 'wabot::auth::v1::7c1e5d0a-ubah-ini-jika-ingin-format-unik-milikmu';
const WRITE_BATCH = 32;

class AuthDecryptError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthDecryptError'; }
}

/* ------------------------------------ kunci ------------------------------------ */

let keyCache = null;

function readSecret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 8) return process.env.AUTH_SECRET;
  if (process.env.AUTH_SECRET) throw new Error('AUTH_SECRET terlalu pendek (minimal 8 karakter)');
  try {
    return fs.readFileSync(paths.SECRET_FILE, 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(paths.SECRET_FILE), { recursive: true });
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(paths.SECRET_FILE, secret + '\n', { mode: 0o600 });
  return secret;
}

function keys() {
  if (keyCache) return keyCache;
  const secret = readSecret();
  const master = crypto.scryptSync(secret, PEPPER, 32, { N: 16384, r: 8, p: 1 });
  const sub = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from(PEPPER), Buffer.from(info), 32));
  keyCache = { enc: sub('wbx-enc'), name: sub('wbx-name') };
  return keyCache;
}
/** Hanya untuk test. */
function _resetKeyCache() { keyCache = null; }

/* ------------------------------ enkripsi / nama file ------------------------------ */

function fileNameFor(logical) {
  return crypto.createHmac('sha256', keys().name).update(String(logical)).digest('hex').slice(0, 32) + '.wbx';
}

function encrypt(plain, logical) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keys().enc, iv);
  c.setAAD(Buffer.from(`wbx1:${logical}`));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

function decrypt(blob, logical) {
  if (blob.length < 4 + 12 + 16 || !blob.subarray(0, 4).equals(MAGIC)) throw new AuthDecryptError('format file auth tidak dikenal');
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const ct = blob.subarray(32);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keys().enc, iv);
    d.setAAD(Buffer.from(`wbx1:${logical}`));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new AuthDecryptError('gagal dekripsi (kunci salah atau file rusak/diubah)');
  }
}

/* ------------------------------------ mutex ------------------------------------ */

const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

async function writeAtomic(file, buf, durable) {
  const tmp = `${file}.tmp`;
  const fh = await fsp.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(buf);
    if (durable) await fh.datasync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, file);
}

/* ------------------------------------ API utama ------------------------------------ */

/**
 * @param {string} folder folder auth satu akun
 * @param {{baileys: object, logger?: object}} deps  modul baileys (untuk initAuthCreds, BufferJSON, proto)
 */
async function useEncryptedMultiFileAuthState(folder, { baileys, logger } = {}) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  if (!initAuthCreds || !BufferJSON || !proto) throw new Error('baileys tidak mengekspor initAuthCreds/BufferJSON/proto');
  await fsp.mkdir(folder, { recursive: true });

  const pathOf = (logical) => path.join(folder, fileNameFor(logical));
  const credsPath = pathOf('creds');

  const readValue = (logical, { strict } = {}) =>
    withLock(pathOf(logical), async () => {
      const file = pathOf(logical);
      let blob;
      try {
        blob = await fsp.readFile(file);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
      try {
        return JSON.parse(decrypt(blob, logical).toString('utf8'), BufferJSON.reviver);
      } catch (err) {
        if (strict) throw err;
        logger && logger.warn({ event: 'auth.key.unreadable', file: path.basename(file), reason: err.message }, `file kunci auth tidak terbaca: ${logical}`);
        await fsp.rename(file, `${file}.corrupt`).catch(() => {});
        return null;
      }
    });

  // creds: bila ada tapi tak terbaca -> JANGAN buat creds baru diam-diam (akan menimpa sesi). Lempar error.
  let creds;
  try {
    creds = await readValue('creds', { strict: true });
  } catch (err) {
    throw new AuthDecryptError(`creds tidak bisa dibuka: ${err.message}. Periksa AUTH_SECRET / data/.secret, atau restore dari backup.`);
  }
  if (!creds) {
    // Folder berisi file .wbx tapi creds tidak ditemukan => hampir pasti kunci (AUTH_SECRET) berbeda: nama file hasil HMAC berubah.
    const orphan = fs.existsSync(folder) && fs.readdirSync(folder).some((f) => f.endsWith('.wbx'));
    if (orphan) throw new AuthDecryptError('folder auth berisi data terenkripsi tetapi creds tidak ditemukan dengan kunci saat ini. Periksa AUTH_SECRET / data/.secret, atau restore dari backup.');
  }
  const isNew = !creds;
  creds = creds || initAuthCreds();
  let lastCreds = isNew ? undefined : JSON.stringify(creds, BufferJSON.replacer);

  return {
    isNew,
    folder,
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readValue(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            const items = data[category];
            for (const id in items) {
              const value = items[id];
              const logical = `${category}-${id}`;
              const file = pathOf(logical);
              tasks.push(value
                ? () => withLock(file, () => writeAtomic(file, encrypt(Buffer.from(JSON.stringify(value, BufferJSON.replacer)), logical), false))
                : () => withLock(file, () => fsp.unlink(file).catch((err) => { if (err.code !== 'ENOENT') throw err; })));
            }
          }
          for (let i = 0; i < tasks.length; i += WRITE_BATCH) {
            await Promise.all(tasks.slice(i, i + WRITE_BATCH).map((run) => run()));
          }
        },
      },
    },
    saveCreds: () => {
      const json = JSON.stringify(creds, BufferJSON.replacer);
      if (json === lastCreds) return Promise.resolve();
      return withLock(credsPath, async () => {
        await writeAtomic(credsPath, encrypt(Buffer.from(json), 'creds'), true);
        lastCreds = json;
      });
    },
  };
}

/** Info folder auth tanpa memuat Baileys. */
function inspectFolder(folder) {
  const info = { exists: false, files: 0, bytes: 0, hasCreds: false, readable: null };
  if (!fs.existsSync(folder)) return info;
  info.exists = true;
  for (const f of fs.readdirSync(folder)) {
    if (!f.endsWith('.wbx')) continue;
    info.files++;
    info.bytes += fs.statSync(path.join(folder, f)).size;
  }
  const c = path.join(folder, fileNameFor('creds'));
  info.hasCreds = fs.existsSync(c);
  if (info.hasCreds) {
    try { decrypt(fs.readFileSync(c), 'creds'); info.readable = true; } catch { info.readable = false; }
  }
  return info;
}

function wipeFolder(folder) {
  if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
}

module.exports = {
  useEncryptedMultiFileAuthState, inspectFolder, wipeFolder, AuthDecryptError,
  fileNameFor, encrypt, decrypt, _resetKeyCache,
};
