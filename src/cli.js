'use strict';
/** CLI interaktif: kelola banyak sesi (start/stop/restart/hapus), auth backup/restore, pengaturan bot, plugin, monitor. */
const fs = require('fs');
const readline = require('readline');
const paths = require('./paths');
const U = require('./utils');
const { Config, LEVELS } = require('./config');
const db = require('./db');
const { LogCenter } = require('./logger');
const { SessionManager } = require('./manager');
const backup = require('./backup');
const cryptoAuth = require('./crypto-auth');
const monitor = require('./monitor');

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[90m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` }
  : { b: (s) => s, dim: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s, c: (s) => s };

const HELP = `
Pemakaian: node index.js [opsi]

  (tanpa opsi)      menu interaktif
  --start-all       jalankan semua sesi yang autoStart lalu masuk menu
  --start=a,b       jalankan sesi tertentu
  --headless        tanpa menu (untuk pm2/systemd); gabungkan dengan --start-all / --start=
  --help            bantuan ini
`;

let rl = null;
let ctx = null;

const ask = (q, def) => new Promise((resolve) => {
  rl.question(`${q}${def !== undefined && def !== '' ? C.dim(` [${def}]`) : ''}: `, (a) => {
    a = a.trim();
    resolve(a === '' && def !== undefined ? String(def) : a);
  });
});
const yes = async (q, def = false) => /^(y|ya|yes|1)$/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
const say = (s = '') => console.log(s);
const clog = (event, msg, extra = {}) => ctx.log.info({ event: `cli.${event}`, ...extra }, msg);

function table(rows, cols) {
  if (!rows.length) return say(C.dim('  (kosong)'));
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.v(r)).length)));
  say('  ' + cols.map((c, i) => C.b(c.h.padEnd(w[i]))).join('  '));
  for (const r of rows) say('  ' + cols.map((c, i) => String(c.v(r)).padEnd(w[i])).join('  '));
}

const statusColor = (s) => ({ open: C.g, connecting: C.y, reconnecting: C.y, starting: C.y, logged_out: C.r, failed: C.r, replaced: C.r }[s] || C.dim)(s);

/* ---------------------------------- tampilan ---------------------------------- */

function showSessions() {
  const list = ctx.manager.list();
  say(C.b('\nSesi akun'));
  table(list, [
    { h: 'NO', v: (r) => list.indexOf(r) + 1 },
    { h: 'NAMA', v: (r) => r.name },
    { h: 'STATUS', v: (r) => r.status },
    { h: 'METODE', v: (r) => r.method },
    { h: 'NOMOR', v: (r) => r.phone || '-' },
    { h: 'MODE', v: (r) => r.mode || '-' },
    { h: 'UPTIME', v: (r) => (r.uptimeMs ? U.formatDuration(r.uptimeMs) : '-') },
    { h: 'AUTH', v: (r) => (r.auth.hasCreds ? (r.auth.readable === false ? 'RUSAK/kunci salah' : 'ada') : 'belum login') },
  ]);
  // warna status ditampilkan terpisah agar lebar kolom tidak rusak
  for (const r of list) if (r.lastError) say(C.dim(`  ${r.name}: ${r.lastError}`));
}

async function pick(prompt, { multi = false, filter = () => true, allowAll = false } = {}) {
  const list = ctx.manager.list().filter(filter);
  if (!list.length) { say(C.y('Tidak ada sesi yang sesuai.')); return []; }
  list.forEach((r, i) => say(`  ${C.b(String(i + 1))}. ${r.name} ${C.dim('(' + r.status + ')')}`));
  const hint = multi ? 'nomor dipisah koma' + (allowAll ? ', atau "all"' : '') : 'nomor';
  const a = await ask(`${prompt} — ${hint}, kosong = batal`);
  if (!a) return [];
  if (multi && allowAll && a.toLowerCase() === 'all') return list.map((r) => r.name);
  const out = [];
  for (const p of a.split(',')) {
    const r = list[Number(p.trim()) - 1] || list.find((x) => x.name === p.trim());
    if (r && !out.includes(r.name)) out.push(r.name);
  }
  return out;
}

/* ------------------------------------ aksi ------------------------------------ */

async function createSession() {
  const name = await ask('Nama sesi (mis. utama, toko1)');
  if (!name) return null;
  const m = await ask('Metode login: 1) QR Code  2) Pairing Code', '1');
  const method = m === '2' ? 'pairing' : 'qr';
  let phone = '';
  if (method === 'pairing') phone = await ask('Nomor WhatsApp dengan kode negara (mis. 628123456789)');
  try {
    const s = ctx.manager.create(name, { method, phone });
    clog('create', `Sesi "${s.name}" dibuat (${method})`, { session: s.name });
    say(C.g(`✔ Sesi "${s.name}" dibuat.`));
    if (await yes('Jalankan sekarang?', true)) await startNames([s.name]);
    return s.name;
  } catch (err) { say(C.r(`✖ ${err.message}`)); return null; }
}

async function startNames(names) {
  for (const n of names) {
    try {
      say(C.dim(`Memulai ${n}…`));
      await ctx.manager.start(n);
    } catch (err) { say(C.r(`✖ ${n}: ${err.message}`)); }
  }
}

async function changeMethod() {
  const [n] = await pick('Ubah metode login sesi', { filter: (r) => ['stopped', 'logged_out', 'failed', 'replaced'].includes(r.status) });
  if (!n) return;
  const m = await ask('Metode: 1) QR  2) Pairing', '1');
  const method = m === '2' ? 'pairing' : 'qr';
  const phone = method === 'pairing' ? await ask('Nomor WhatsApp (kode negara)', ctx.manager.get(n).info.phone || '') : '';
  try { ctx.manager.setMethod(n, method, phone); say(C.g('✔ Tersimpan.')); } catch (err) { say(C.r(`✖ ${err.message}`)); }
}

async function deleteSession() {
  const [n] = await pick('Hapus sesi (logout + hapus auth)');
  if (!n) return;
  if ((await ask(`Ketik nama sesi "${n}" untuk konfirmasi`)) !== n) return say('Dibatalkan.');
  const logs = await yes('Hapus juga log sesi ini?', false);
  const bk = await yes('Hapus juga backup auth sesi ini?', false);
  await ctx.manager.remove(n, { deleteLogs: logs, deleteBackups: bk });
  say(C.g(`✔ Sesi "${n}" dihapus.`));
}

async function authMenu() {
  for (;;) {
    say(C.b('\nBackup & Restore'));
    say('  1. Backup auth sekarang\n  2. Daftar backup auth\n  3. Restore auth dari backup\n  4. Hapus backup auth\n  5. Backup database (LowDB)\n  6. Restore database\n  0. Kembali');
    const c = await ask('Pilih');
    if (c === '0' || c === '') return;
    try {
      if (c === '1') {
        for (const n of await pick('Backup sesi', { multi: true, allowAll: true })) {
          const s = ctx.manager.get(n);
          const r = s.status === 'open' ? await s.backupAuth('manual') : await backup.createBackup(n, s.authFolder, { reason: 'manual', keep: ctx.config.get('auth.backupKeep') });
          clog('backup', `Backup auth ${n}: ${r.id}`, { session: n });
          say(C.g(`✔ ${n}: ${r.id} (${r.files} file)`));
        }
      } else if (c === '2') {
        for (const n of await pick('Lihat backup sesi', { multi: true, allowAll: true })) {
          say(C.b(`\n${n}`));
          table(backup.listBackups(n), [{ h: 'ID', v: (r) => r.id }, { h: 'ALASAN', v: (r) => r.reason }, { h: 'UKURAN', v: (r) => U.formatBytes(r.bytes) }]);
        }
      } else if (c === '3') {
        const [n] = await pick('Restore sesi');
        if (!n) continue;
        const list = backup.listBackups(n);
        if (!list.length) { say(C.y('Belum ada backup.')); continue; }
        list.forEach((b, i) => say(`  ${i + 1}. ${b.id}  ${C.dim(U.formatBytes(b.bytes))}`));
        const b = list[Number(await ask('Nomor backup')) - 1];
        if (!b) continue;
        if (!(await yes(`Restore ${n} dari ${b.id}? Sesi dihentikan sementara`))) continue;
        const r = await ctx.manager.restoreAuth(n, b.id, { startAfter: await yes('Jalankan sesi setelah restore?', true) });
        say(C.g(`✔ Restore selesai (${r.files} file). Backup pengaman: ${r.safetyBackup || '-'}`));
      } else if (c === '4') {
        const [n] = await pick('Hapus backup sesi');
        if (!n) continue;
        const list = backup.listBackups(n);
        list.forEach((b, i) => say(`  ${i + 1}. ${b.id}`));
        const b = list[Number(await ask('Nomor backup')) - 1];
        if (b && (await yes(`Hapus ${b.id}?`))) { backup.deleteBackup(n, b.id); say(C.g('✔ Dihapus.')); }
      } else if (c === '5') {
        const r = await db.backupDatabases('manual', 10);
        clog('db_backup', `Backup database: ${r.id}`);
        say(C.g(`✔ ${r.id}`));
      } else if (c === '6') {
        const list = db.listDatabaseBackups();
        if (!list.length) { say(C.y('Belum ada backup database.')); continue; }
        list.forEach((b, i) => say(`  ${i + 1}. ${b.id}`));
        const b = list[Number(await ask('Nomor backup')) - 1];
        if (b && (await yes(`Restore database dari ${b.id}?`))) { await db.restoreDatabases(b.id); say(C.g('✔ Database di-restore. Restart sesi agar pengaturan terbaca ulang.')); }
      }
    } catch (err) { say(C.r(`✖ ${err.message}`)); }
  }
}

async function accountSettings() {
  const [n] = await pick('Pengaturan akun');
  if (!n) return;
  const store = await db.openAccount(n);
  const running = ctx.manager.get(n).status !== 'stopped';
  try {
    for (;;) {
      const s = store.data.settings;
      const mode = s.mode || ctx.config.get('bot.defaultMode');
      say(C.b(`\nPengaturan akun "${n}"`));
      say(`  1. Mode command        : ${C.c(mode)}  (private = hanya BotNoi, public = semua orang)`);
      say(`  2. Command (global)    : ${s.commandsEnabled === false ? C.r('OFF') : C.g('ON')}`);
      say(`  3. Prefix              : ${s.prefix || ctx.config.get('bot.prefix')}`);
      say(`  4. Rich Message        : ${s.richEnabled === false ? C.r('OFF') : C.g('ON')}`);
      say(`  5. Command nonaktif    : ${(s.disabledCommands || []).join(', ') || '-'}  (ubah via .cmd di WhatsApp)`);
      say('  0. Kembali');
      const c = await ask('Pilih');
      if (c === '0' || c === '') break;
      if (c === '1') s.mode = mode === 'private' ? 'public' : 'private';
      else if (c === '2') s.commandsEnabled = s.commandsEnabled === false;
      else if (c === '3') { const p = await ask('Prefix baru (1-3 karakter)'); if (p && p.length <= 3) s.prefix = p; }
      else if (c === '4') s.richEnabled = s.richEnabled === false ? true : false;
      store.save();
      clog('account_settings', `Pengaturan akun ${n} diubah`, { session: n, settings: s });
    }
  } finally {
    await store.flush();
    if (!running) await db.closeAccount(n);
  }
}

async function globalSettings() {
  for (;;) {
    say(C.b('\nPengaturan bot (global)'));
    const keys = ctx.config.keys();
    keys.forEach((k, i) => say(`  ${String(i + 1).padStart(2)}. ${k.padEnd(34)} ${C.c(String(ctx.config.get(k)))}${ctx.config.isLocked(k) ? C.y('  (dikunci ENV)') : ''}`));
    say('   0. Kembali   |   r<nomor> = reset ke default');
    const c = await ask('Nomor pengaturan');
    if (c === '0' || c === '') return;
    const reset = c.startsWith('r');
    const key = keys[Number(reset ? c.slice(1) : c) - 1];
    if (!key) continue;
    if (reset) { ctx.config.reset(key); clog('config', `Reset ${key}`, { key }); continue; }
    const rule = ctx.config.schema[key];
    const hint = rule.type === 'enum' ? rule.values.join('/') : rule.type === 'boolean' ? 'on/off' : rule.type;
    const v = await ask(`${key} (${hint})`, ctx.config.get(key));
    const r = ctx.config.set(key, v);
    if (r.ok) { say(C.g(`✔ ${key} = ${r.value}`)); clog('config', `Pengaturan ${key} = ${r.value}`, { key, value: r.value }); } else say(C.r(`✖ ${r.error}`));
  }
}

async function pluginMenu() {
  const [n] = await pick('Plugin untuk sesi', { filter: (r) => !['stopped'].includes(r.status) });
  if (!n) return say(C.dim('Plugin dikelola per sesi yang sedang berjalan.'));
  const pm = ctx.manager.get(n).plugins;
  for (;;) {
    const st = pm.status();
    say(C.b(`\nPlugin — ${n}`));
    table(st, [
      { h: 'NO', v: (r) => st.indexOf(r) + 1 }, { h: 'NAMA', v: (r) => r.name }, { h: 'VER', v: (r) => r.version },
      { h: 'STATE', v: (r) => r.state }, { h: 'ON', v: (r) => (r.enabled ? 'ya' : 'tidak') }, { h: 'CMD', v: (r) => r.commands },
      { h: 'ERR', v: (r) => r.errors }, { h: 'DEP', v: (r) => r.dependencies.join(',') || '-' },
    ]);
    say('\n  e<no> aktifkan | d<no> nonaktifkan | r<no> reload | s<no> start | x<no> stop | i<no> info | a = rescan | 0 kembali');
    const c = await ask('Aksi');
    if (c === '0' || c === '') return;
    if (c === 'a') { say(`Plugin baru: ${(await pm.rescan()).join(', ') || '-'}`); continue; }
    const p = st[Number(c.slice(1)) - 1];
    if (!p) continue;
    let r;
    if (c[0] === 'e') r = await pm.enable(p.name);
    else if (c[0] === 'd') r = await pm.disable(p.name);
    else if (c[0] === 'r') r = await pm.reload(p.name);
    else if (c[0] === 's') r = await pm.start(p.name);
    else if (c[0] === 'x') r = await pm.stop(p.name);
    else if (c[0] === 'i') { say(JSON.stringify({ ...p, config: pm.getConfig(pm.get(p.name)) }, null, 2)); continue; }
    clog('plugin', `Plugin ${p.name}: ${c[0]}`, { session: n, plugin: p.name });
    say(r && r.ok === false ? C.r(`✖ ${r.error}`) : C.g('✔ Selesai.'));
  }
}

async function monitorView() {
  const m = monitor.peek();
  say(C.b('\nMonitor'));
  say(`  Uptime proses : ${U.formatDuration(m.uptimeMs)}   PID ${m.pid}   Node ${m.node}`);
  say(`  Memori        : RSS ${U.formatBytes(m.rss)} | heap ${U.formatBytes(m.heapUsed)}/${U.formatBytes(m.heapTotal)} | sistem bebas ${U.formatBytes(m.freeMem)}/${U.formatBytes(m.totalMem)}`);
  say(`  CPU           : ${m.cpuPercent}%  (load ${m.loadAvg.join(' ')} · ${m.cpus} core)`);
  showSessions();
  for (const s of ctx.manager.running()) {
    const sm = s.logs ? await ctx.logs.summary(s.name) : null;
    if (sm) say(C.dim(`  log ${s.name}: ${sm.total} entri (${Object.entries(sm.byLevel).map(([k, v]) => `${k}:${v}`).join(' ')}) · pesan masuk ${sm.messagesIn} · keluar ${sm.messagesOut}`));
  }
}

async function logView() {
  const [n] = await pick('Lihat log sesi (termasuk "core" ketik core)');
  const scope = n || ((await ask('Scope log', 'core')) || 'core');
  const lim = Number(await ask('Jumlah entri', '30')) || 30;
  const rows = await ctx.logs.query(scope, { limit: lim });
  for (const e of rows) say(`${C.dim(U.formatTime(e.time))} ${e.level.toUpperCase().padEnd(5)} ${C.dim('[' + e.source + ']')} ${e.msg ?? e.event ?? ''}`);
  const sessions = ctx.logs.listSessions(scope);
  say(C.dim(`\n${sessions.length} sesi log di data/logs/${scope}/ — terbaru: ${sessions[0] ? sessions[0].id : '-'}`));
}

/* ------------------------------------ menu ------------------------------------ */

async function mainMenu() {
  for (;;) {
    showSessions();
    say(C.b('\nMenu utama'));
    say([
      '  1. Buat sesi baru', '  2. Start sesi (bisa banyak sekaligus)', '  3. Stop sesi', '  4. Restart sesi',
      '  5. Hapus sesi (logout + hapus auth)', '  6. Ubah metode login (QR / Pairing)', '  7. Backup & Restore',
      '  8. Pengaturan akun (mode, command, prefix)', '  9. Pengaturan bot (global)', ' 10. Plugin', ' 11. Monitor', ' 12. Lihat log', '  0. Shutdown',
    ].join('\n'));
    const c = await ask('Pilih');
    try {
      if (c === '1') await createSession();
      else if (c === '2') await startNames(await pick('Start sesi', { multi: true, allowAll: true, filter: (r) => ['stopped', 'logged_out', 'failed', 'replaced'].includes(r.status) }));
      else if (c === '3') for (const n of await pick('Stop sesi', { multi: true, allowAll: true, filter: (r) => r.status !== 'stopped' })) { await ctx.manager.stop(n, 'cli'); clog('stop', `Sesi ${n} dihentikan`, { session: n }); say(C.g(`✔ ${n} berhenti`)); }
      else if (c === '4') for (const n of await pick('Restart sesi', { multi: true, allowAll: true })) { await ctx.manager.restart(n); clog('restart', `Sesi ${n} di-restart`, { session: n }); say(C.g(`✔ ${n} di-restart`)); }
      else if (c === '5') await deleteSession();
      else if (c === '6') await changeMethod();
      else if (c === '7') await authMenu();
      else if (c === '8') await accountSettings();
      else if (c === '9') await globalSettings();
      else if (c === '10') await pluginMenu();
      else if (c === '11') await monitorView();
      else if (c === '12') await logView();
      else if (c === '0') { if (await yes('Shutdown bot dan semua sesi?', true)) return; }
    } catch (err) {
      ctx.log.error({ event: 'cli.error', err }, `CLI error: ${err.message}`);
      say(C.r(`✖ ${err.message}`));
    }
  }
}

/* ------------------------------------- QR ------------------------------------- */

async function renderQr(text) {
  try {
    const mod = await import('qr');
    const enc = mod.default || mod.encodeQR;
    const out = enc(text, 'ascii');
    if (typeof out === 'string' && out.trim()) return out;
  } catch { /* paket qr tidak ada */ }
  return null;
}

function wireAuthPrompts(manager) {
  manager.on('qr', async (name, qr) => {
    const art = await renderQr(qr);
    say(C.b(`\n=== QR untuk sesi "${name}" — scan: WhatsApp > Perangkat tertaut > Tautkan perangkat ===`));
    say(art || `(paket "qr" belum terpasang — jalankan npm i qr)\nTeks QR: ${qr}`);
  });
  manager.on('pairing', (name, code, phone) => {
    say(C.b(`\n=== Pairing code sesi "${name}" (${phone}) ===`));
    say(`    ${C.g(code.length === 8 ? code.slice(0, 4) + '-' + code.slice(4) : code)}`);
    say(C.dim('WhatsApp > Perangkat tertaut > Tautkan perangkat > Tautkan dengan nomor telepon'));
  });
  manager.on('logout', (name) => say(C.y(`\n⚠ Sesi "${name}" logout dari WhatsApp. Start ulang untuk login lagi.`)));
}

/* ------------------------------------- main ------------------------------------- */

async function main(argv) {
  const flags = {};
  for (const a of argv) {
    if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
  }
  if (flags.help || flags.h) return console.log(HELP);

  paths.ensure();
  const secretExisted = fs.existsSync(paths.SECRET_FILE) || !!process.env.AUTH_SECRET;
  const config = new Config();
  const coreStore = await db.openCore();
  config.attach(coreStore);
  const logs = new LogCenter(config);
  await logs.openScope('core');
  const log = logs.logger('core', 'core');
  const manager = new SessionManager({ config, logs, coreStore });
  ctx = { config, coreStore, logs, log, manager };
  for (const w of config.warnings) log.warn({ event: 'config.warning' }, w);

  try { cryptoAuth.fileNameFor('probe'); } catch (err) { console.error(`Kunci auth bermasalah: ${err.message}`); process.exit(1); }
  if (!secretExisted) {
    log.warn({ event: 'auth.secret_created', file: paths.SECRET_FILE }, 'Kunci enkripsi auth dibuat otomatis');
    say(C.y(`\n⚠ Kunci enkripsi auth dibuat: ${paths.SECRET_FILE}\n  SIMPAN/BACKUP file ini. Tanpa kunci yang sama, folder auth tidak bisa dibuka (atau set AUTH_SECRET di .env).\n`));
  }
  log.info({ event: 'core.start', node: process.version, pid: process.pid, args: argv }, `Core dimulai (Node ${process.version}, pid ${process.pid})`);
  const hasFfmpeg = await U.hasBinary('ffmpeg');
  log.info({ event: 'core.deps', ffmpeg: hasFfmpeg }, `ffmpeg ${hasFfmpeg ? 'tersedia' : 'TIDAK ditemukan (fitur .rbit membutuhkannya)'}`);

  wireAuthPrompts(manager);
  manager.watchPlugins();

  const monTimer = setInterval(() => {
    const snap = monitor.tick();
    log.debug({ event: 'monitor.snapshot', source: 'monitor', ...snap }, `RSS ${U.formatBytes(snap.rss)} · heap ${U.formatBytes(snap.heapUsed)} · CPU ${snap.cpuPercent}%`);
    for (const s of manager.running()) if (s.logs) s.logs.logger('monitor').debug({ event: 'monitor.snapshot', status: s.status, retries: s.retries, ...snap }, `Status ${s.status}`);
  }, config.get('monitor.intervalMs'));
  monTimer.unref();

  let closing = false;
  const shutdown = async (why, code = 0) => {
    if (closing) { console.log('\nPaksa keluar.'); process.exit(1); }
    closing = true;
    console.log(`\nShutdown (${why})…`);
    log.info({ event: 'core.shutdown_request', why }, `Shutdown diminta: ${why}`);
    try {
      clearInterval(monTimer);
      await manager.shutdown();
      const t = setTimeout(() => process.exit(code), 8000);
      t.unref();
      await db.backupDatabases('shutdown', 5).catch(() => {});
      await db.flushAll();
      await logs.shutdown();
      await db.flushAll();
    } catch (err) { console.error('Error saat shutdown:', err.message); }
    if (rl) rl.close();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => { logs.flushSync(); });
  process.on('unhandledRejection', (err) => log.error({ event: 'core.unhandled_rejection', err }, `Unhandled rejection: ${err && err.message}`));
  process.on('uncaughtException', (err) => log.fatal({ event: 'core.uncaught_exception', err }, `Uncaught exception: ${err && err.message}`));

  const headless = !!flags.headless || !process.stdin.isTTY;
  const toStart = [];
  if (flags['start-all']) toStart.push(...manager.names().filter((n) => manager.get(n).info.autoStart !== false));
  if (typeof flags.start === 'string') toStart.push(...flags.start.split(',').map((s) => s.trim()).filter((n) => manager.has(n)));

  if (headless) {
    if (!toStart.length) { console.log('Mode headless butuh --start-all atau --start=nama. Buat sesi lewat menu interaktif dulu.'); return shutdown('tidak ada sesi', 1); }
    await manager.startMany([...new Set(toStart)]);
    return; // proses tetap hidup selama socket aktif
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => shutdown('Ctrl+C'));
  say(C.b(`\n  ${config.get('bot.name')} — WhatsApp Multi-Akun  (Baileys fork · LowDB · Pino · Auth terenkripsi)`));
  say(C.dim(`  Data: ${paths.DATA}\n`));

  if (!manager.names().length) {
    say(C.y('Belum ada sesi. Buat sesi pertama Anda.'));
    await createSession();
  } else if (toStart.length) {
    await startNames([...new Set(toStart)]);
  } else {
    showSessions();
    const a = await ask('\nMulai: [a] semua sesi  [n] pilih nomor  [b] buat sesi baru  [enter] langsung ke menu', '');
    if (a.toLowerCase() === 'a') await startNames(manager.names());
    else if (a.toLowerCase() === 'n') await startNames(await pick('Start sesi', { multi: true, allowAll: true }));
    else if (a.toLowerCase() === 'b') await createSession();
  }

  await mainMenu();
  await shutdown('menu', 0);
}

module.exports = { main, LEVELS };
