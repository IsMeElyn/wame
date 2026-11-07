'use strict';
/** Manajemen plugin dari WhatsApp + updater file tanpa restart (.update). Khusus BotNoi. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const paths = require('../src/paths');
const U = require('../src/utils');
const hot = require('../src/hot');
const { purgeModules } = require('../src/plugin-manager');

const ICON = { running: '🟢', stopped: '⚫', disabled: '⛔', failed: '🔴', blocked: '🟡', loaded: '⚪', starting: '🟠', stopping: '🟠' };
const HOT_SRC = new Set(['router.js', 'messages.js', 'rich.js', 'groups.js', 'stats.js']);
const BACKUP_DIR = path.join(paths.BACKUPS, '_updates');

/** Tentukan path tujuan yang DIIZINKAN (hanya folder hot-reloadable). */
function resolveTarget(spec, fallbackName) {
  let rel = String(spec || fallbackName || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!rel) return { error: 'nama file tidak ada' };
  if (!rel.includes('/')) rel = `${rel.endsWith('.html') ? 'views' : 'plugins'}/${rel}`;
  const m = /^(plugins|lib|views|src)\/([A-Za-z0-9._-]+)$/.exec(rel);
  if (!m) return { error: 'path tidak valid. Contoh: plugins/nama.js, lib/x.js, views/log.html' };
  const [, dir, file] = m;
  if (file.startsWith('.') || file.includes('..')) return { error: 'nama file tidak valid' };
  if (dir === 'views' && !file.endsWith('.html')) return { error: 'views/ hanya untuk .html' };
  if (dir !== 'views' && !file.endsWith('.js')) return { error: `${dir}/ hanya untuk .js` };
  if (dir === 'src' && !HOT_SRC.has(file)) return { error: `src/${file} butuh restart bot; yang bisa hot-update: ${[...HOT_SRC].join(', ')}` };
  return { dir, file, rel: `${dir}/${file}`, abs: path.join(paths.ROOT, dir, file) };
}

function listUpdatable() {
  const out = [];
  for (const [dir, ext] of [['plugins', '.js'], ['lib', '.js'], ['views', '.html']]) {
    try { for (const f of fs.readdirSync(path.join(paths.ROOT, dir))) if (f.endsWith(ext)) out.push(`${dir}/${f}`); } catch { /* ignore */ }
  }
  for (const f of HOT_SRC) out.push(`src/${f}`);
  return out;
}

async function applyReload(ctx, t) {
  if (t.dir === 'plugins') {
    const r = await ctx.session.manager.reloadPluginFile(t.abs);
    const mine = r[ctx.session.name];
    return mine && mine.ok ? { ok: true, info: mine.name ? `plugin ${mine.name} (${mine.state})` : 'plugin' } : { ok: false, error: mine ? mine.error : 'reload tidak dijalankan' };
  }
  if (t.dir === 'lib') {
    purgeModules();
    const pm = ctx.plugins.manager;
    for (const e of [...pm.entries.values()]) if (e.def) { const r = await pm.reloadFile(e.file, { purge: false }); if (!r.ok) return { ok: false, error: `${e.name}: ${r.error}` }; }
    return { ok: true, info: 'lib dimuat ulang beserta plugin pemakainya' };
  }
  if (t.dir === 'src') {
    hot.invalidate();
    try { hot(t.file.replace(/\.js$/, '')); } catch (err) { return { ok: false, error: err.message }; }
    const err = hot.errors.get(t.file.replace(/\.js$/, ''));
    return err ? { ok: false, error: err.message } : { ok: true, info: 'modul inti dimuat ulang' };
  }
  hot.invalidate();
  return { ok: true, info: 'template dipakai pada render berikutnya' };
}

module.exports = {
  name: 'plugin-admin',
  version: '1.0.0',
  description: 'Kelola plugin (enable/disable/reload/config) dan updater file tanpa restart',
  category: 'Kontrol (BotNoi)',
  dependencies: { 'core-admin': '>=1.0.0' },
  commands: [
    {
      name: 'plugin', aliases: ['plugins'], control: true, ownerOnly: true, usage: '.plugin [list|info|enable|disable|reload|start|stop|config|rescan]', description: 'Kelola plugin',
      async run(ctx, m, args) {
        const pm = ctx.plugins.manager;
        const sub = (args[0] || 'list').toLowerCase();
        const name = args[1];
        if (sub === 'list') {
          const list = pm.status().map((p) => ({ ...p, icon: ICON[p.state] || '❔', deps: p.dependencies.join(', ') || '-' }));
          return ctx.sendRich(m.chat, 'plugins', { session: ctx.session.name, plugins: list }, { quoted: m.raw });
        }
        if (sub === 'rescan') { const a = await pm.rescan(); return m.reply(a.length ? `🆕 Plugin baru: ${a.join(', ')}` : 'Tidak ada plugin baru.'); }
        if (!name) return m.reply('Sebutkan nama plugin. Contoh: .plugin reload chess');
        const e = pm.get(name);
        if (!e) return m.reply(`Plugin "${name}" tidak ditemukan.`);
        if (sub === 'info') {
          const st = pm.status().find((p) => p.name === name);
          return m.reply(`🧩 *${st.name}* v${st.version}\n${st.description}\nStatus: ${ICON[st.state] || ''} ${st.state}${st.error ? ` (${st.error})` : ''}\nFile: ${st.file}\nCommand: ${st.commands}\nDependensi: ${st.dependencies.join(', ') || '-'}\nError: ${st.errors}${st.lastError ? ` — ${st.lastError}` : ''}\nListener event: ${st.listeners.events} · timer: ${st.listeners.timers}\nUptime: ${U.formatDuration(st.uptimeMs)}\nKonfigurasi: ${e.def ? JSON.stringify(pm.getConfig(e)) : '-'}`);
        }
        if (['enable', 'disable', 'reload', 'start', 'stop'].includes(sub)) {
          if (name === 'core-admin' && ['disable', 'stop'].includes(sub)) return m.reply('⛔ core-admin tidak boleh dimatikan.');
          const r = await pm[sub](name);
          return m.reply(r && r.ok === false ? `❌ ${sub} gagal: ${r.error}` : `✅ ${sub} ${name} selesai (status: ${(pm.get(name) || {}).state})`);
        }
        if (sub === 'config') {
          if (!e.def) return m.reply('Plugin gagal dimuat.');
          if (!args[2]) return m.reply(`⚙️ Konfigurasi ${name}:\n${JSON.stringify(pm.getConfig(e), null, 2)}\n\n.plugin config ${name} <key> <nilai>`);
          if (args[2] === 'reset') { pm.resetConfig(e); return m.reply('✅ Konfigurasi direset ke default.'); }
          const r = pm.setConfig(e, args[2], args.slice(3).join(' '));
          return m.reply(r.ok ? `✅ ${args[2]} = ${r.value}` : `❌ ${r.error}`);
        }
        return m.reply('Subcommand: list, info, enable, disable, reload, start, stop, config, rescan');
      },
    },
    {
      name: 'update', aliases: ['upd'], control: true, ownerOnly: true, usage: '.update [list|rollback <file>] (kirim/reply file)', description: 'Perbarui plugin/lib/view dari file yang dikirim — tanpa restart',
      async run(ctx, m, args) {
        const sub = (args[0] || '').toLowerCase();
        if (sub === 'list') return m.reply(`📁 *File yang bisa diperbarui*\n${listUpdatable().map((f) => `• ${f}`).join('\n')}\n\nKirim file (sebagai dokumen) dengan caption: .update plugins/nama.js\nAtau reply dokumen dengan .update`);
        if (sub === 'rollback') {
          const t = resolveTarget(args[1]);
          if (t.error) return m.reply(`❌ ${t.error}`);
          const base = t.rel.replace(/\//g, '__');
          const baks = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(base + '.')).sort() : [];
          if (!baks.length) return m.reply('Tidak ada backup untuk file itu.');
          fs.copyFileSync(path.join(BACKUP_DIR, baks[baks.length - 1]), t.abs);
          const r = await applyReload(ctx, t);
          return m.reply(r.ok ? `↩️ Rollback ${t.rel} dari ${baks[baks.length - 1]} — ${r.info}` : `⚠️ Rollback ditulis tapi reload gagal: ${r.error}`);
        }
        const media = m.target;
        if (!media || media.type !== 'document') return m.reply('Kirim file sebagai *dokumen* dengan caption `.update plugins/nama.js`, atau reply dokumen dengan `.update`. Lihat `.update list`.');
        const t = resolveTarget(args[0], media.fileName);
        if (t.error) return m.reply(`❌ ${t.error}`);
        const buf = await m.download();
        if (buf.length > 2 * 1024 * 1024) return m.reply('❌ File terlalu besar (maks 2MB).');
        const code = buf.toString('utf8');
        if (t.file.endsWith('.js')) {
          try { new vm.Script(code, { filename: t.file }); } catch (err) { return m.reply(`❌ Syntax error, file TIDAK diterapkan:\n${err.message}`); }
        }
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        let bakName = null;
        if (fs.existsSync(t.abs)) {
          bakName = `${t.rel.replace(/\//g, '__')}.${U.stamp()}.bak`;
          fs.copyFileSync(t.abs, path.join(BACKUP_DIR, bakName));
        }
        fs.writeFileSync(t.abs, code);
        ctx.logger.warn({ event: 'update.applied', file: t.rel, bytes: buf.length, by: m.senderNumber }, `File diperbarui via WhatsApp: ${t.rel}`);
        const r = await applyReload(ctx, t);
        if (!r.ok) {
          if (bakName) fs.copyFileSync(path.join(BACKUP_DIR, bakName), t.abs); else fs.rmSync(t.abs, { force: true });
          await applyReload(ctx, t).catch(() => {});
          ctx.logger.error({ event: 'update.rolled_back', file: t.rel, error: r.error }, `Update ${t.rel} dibatalkan: ${r.error}`);
          return m.reply(`❌ Gagal memuat versi baru, *dikembalikan ke versi lama*.\n${r.error}`);
        }
        await m.reply(`✅ ${t.rel} diperbarui (${U.formatBytes(buf.length)}) — ${r.info}${bakName ? `\nBackup lama: ${bakName}` : ''}`);
      },
    },
  ],
};
