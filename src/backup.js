'use strict';
/**
 * Backup & restore folder auth per akun.
 * Isi backup = file .wbx apa adanya (sudah terenkripsi), dibungkus satu file .wbak (JSON + base64).
 *   data/backups/<akun>/<stamp>_<alasan>.wbak
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { stamp } = require('./utils');
const cryptoAuth = require('./crypto-auth');

const dirFor = (account) => path.join(paths.BACKUPS, account);

function listBackups(account) {
  const dir = dirFor(account);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.wbak')) continue;
    const file = path.join(dir, f);
    const st = fs.statSync(file);
    const id = f.slice(0, -5);
    const [at, ...reason] = id.split('_');
    out.push({ id, file, bytes: st.size, mtime: st.mtimeMs, reason: id.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_?/, '') || 'manual', at });
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

async function createBackup(account, authFolder, { reason = 'manual', keep = 10 } = {}) {
  if (!fs.existsSync(authFolder)) throw new Error('folder auth belum ada');
  const files = fs.readdirSync(authFolder).filter((f) => f.endsWith('.wbx'));
  if (!files.length) throw new Error('tidak ada file auth untuk dibackup');
  const bundle = {
    format: 'wbak1',
    account,
    reason,
    createdAt: new Date().toISOString(),
    files: files.map((f) => ({ name: f, data: fs.readFileSync(path.join(authFolder, f)).toString('base64') })),
  };
  const dir = dirFor(account);
  fs.mkdirSync(dir, { recursive: true });
  const safeReason = String(reason).replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'manual';
  let id = `${stamp()}_${safeReason}`;
  for (let n = 2; fs.existsSync(path.join(dir, `${id}.wbak`)); n++) id = `${stamp()}_${safeReason}-${n}`;
  const file = path.join(dir, `${id}.wbak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bundle), { mode: 0o600 });
  fs.renameSync(tmp, file);
  for (const old of listBackups(account).slice(keep)) {
    if (old.reason !== 'pre-restore') fs.rmSync(old.file, { force: true });
  }
  return { id, file, files: files.length, bytes: fs.statSync(file).size };
}

/** Akun HARUS dalam keadaan berhenti saat restore. */
async function restoreBackup(account, authFolder, id) {
  const file = path.join(dirFor(account), `${id}.wbak`);
  if (!fs.existsSync(file)) throw new Error(`backup "${id}" tidak ditemukan`);
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (bundle.format !== 'wbak1' || !Array.isArray(bundle.files)) throw new Error('format backup tidak valid');

  let safety = null;
  try { safety = await createBackup(account, authFolder, { reason: 'pre-restore', keep: 50 }); } catch { /* folder kosong */ }

  fs.rmSync(authFolder, { recursive: true, force: true });
  fs.mkdirSync(authFolder, { recursive: true });
  for (const f of bundle.files) {
    if (!/^[a-f0-9]{32}\.wbx$/.test(f.name)) throw new Error(`nama file tidak valid di backup: ${f.name}`);
    fs.writeFileSync(path.join(authFolder, f.name), Buffer.from(f.data, 'base64'), { mode: 0o600 });
  }
  const check = cryptoAuth.inspectFolder(authFolder);
  if (check.hasCreds && check.readable === false) {
    // kunci tidak cocok -> kembalikan kondisi sebelumnya
    if (safety) await restoreBackup(account, authFolder, safety.id).catch(() => {});
    throw new Error('creds di backup tidak bisa didekripsi dengan kunci saat ini (AUTH_SECRET berbeda?) — restore dibatalkan');
  }
  return { id, files: bundle.files.length, createdAt: bundle.createdAt, safetyBackup: safety && safety.id };
}

function deleteBackup(account, id) {
  const file = path.join(dirFor(account), `${id}.wbak`);
  if (!fs.existsSync(file)) throw new Error(`backup "${id}" tidak ditemukan`);
  fs.rmSync(file, { force: true });
}

module.exports = { createBackup, restoreBackup, listBackups, deleteBackup, dirFor };
