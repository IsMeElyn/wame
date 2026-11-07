'use strict';
/**
 * .log   -> log terbaru sebagai Rich Message (filter level / sumber / pencarian grup)
 * .mlog  -> manajer log memakai Interactive Message (tombol & daftar): reset, hapus, ekspor, pilih sesi
 */
const fs = require('fs');
const U = require('../src/utils');

const ICON = { trace: '▫️', debug: '🐞', info: 'ℹ️', warn: '⚠️', error: '❌', fatal: '💀' };
const LEVELS = Object.keys(ICON);

function row(e) {
  return { time: U.formatTime(e.time), lv: `${ICON[e.level] || ''} ${e.level}`, src: U.truncate(String(e.source || '').replace(/^plugin:/, 'p:'), 18), msg: U.truncate(String(e.msg ?? e.event ?? '').replace(/\s+/g, ' '), 120) };
}

function resolveSession(ctx, token) {
  const list = ctx.session.logs.listSessions(ctx.session.name);
  if (!token) return null;
  if (/^\d+$/.test(token) && list[Number(token) - 1]) return list[Number(token) - 1];
  return list.find((s) => s.id === token) || list.find((s) => s.id.startsWith(token)) || null;
}

const btn = (text, id) => ({ text, id });

async function panel(ctx, m, extra = '') {
  const logs = ctx.session.logs;
  const sm = await logs.summary(ctx.session.name);
  const list = logs.listSessions(ctx.session.name);
  const size = list.reduce((a, s) => a + s.size, 0);
  await ctx.sendInteractive(m.chat, {
    text: `🗂️ *Manajer Log* — ${ctx.session.name}\n${extra ? extra + '\n\n' : ''}Sesi aktif: ${sm.id}\nEntri: ${sm.total} (${LEVELS.map((l) => `${l}:${(sm.byLevel || {})[l] || 0}`).join(' ')})\nTotal sesi log: ${list.length} · ${U.formatBytes(size)}`,
    footer: 'BotNoi only',
    nativeFlow: [btn('📂 Daftar sesi', `${m.prefix}mlog list`), btn('🧹 Reset sesi ini', `${m.prefix}mlog reset`), btn('📤 Ekspor sesi ini', `${m.prefix}mlog export`), btn('🗑️ Hapus sesi lama', `${m.prefix}mlog delold`)],
  }, { quoted: m.raw });
}

function confirm(ctx, m, text, yesId) {
  return ctx.sendInteractive(m.chat, { text, footer: 'Tindakan ini tidak bisa dibatalkan', nativeFlow: [btn('✅ Ya, lanjutkan', yesId), btn('✖️ Batal', `${m.prefix}mlog`)] }, { quoted: m.raw });
}

module.exports = {
  name: 'logviewer',
  version: '1.0.0',
  description: 'Lihat log (.log) dan kelola log (.mlog) lewat WhatsApp',
  category: 'Log',
  commands: [
    {
      name: 'log', ownerOnly: true, usage: '.log [jumlah|level|search <grup>|src <sumber>]', description: 'Log terbaru (Rich Message). Contoh: .log 50 · .log error · .log search dtl',
      async run(ctx, m, args) {
        const scope = ctx.session.name;
        const logs = ctx.session.logs;
        const opts = { limit: 25 };
        const filters = [];
        let groupsMatched = '';
        const first = (args[0] || '').toLowerCase();
        if (first === 'search' || first === 'cari') {
          const q = args.slice(1).join(' ').trim();
          if (!q) return m.reply('Gunakan: .log search <inisial/nama grup atau kata kunci>');
          const gs = ctx.groups.find(q);
          opts.q = q; opts.jids = gs.map((g) => g.id); opts.limit = 40;
          groupsMatched = gs.slice(0, 5).map((g) => g.subject).join(', ') + (gs.length > 5 ? ` (+${gs.length - 5})` : '');
          filters.push(`cari "${q}"`);
        } else if (first === 'src' || first === 'source') {
          opts.source = args[1] || ''; filters.push(`sumber ${opts.source}*`);
        } else if (first === 'session' || first === 'sesi') {
          const s = resolveSession(ctx, args[1]);
          if (!s) return m.reply('Sesi log tidak ditemukan. Lihat: .mlog list');
          opts.session = s.id; filters.push(`sesi ${s.id}`);
        } else if (LEVELS.includes(first)) {
          opts.minLevel = first; filters.push(`level ≥ ${first}`);
        } else if (/^\d+$/.test(first)) opts.limit = Math.min(100, Math.max(1, Number(first)));
        if (opts.minLevel === undefined && LEVELS.includes((args[1] || '').toLowerCase()) && !opts.q) { opts.minLevel = args[1].toLowerCase(); filters.push(`level ≥ ${opts.minLevel}`); }

        const entries = await logs.query(scope, opts);
        const sm = await logs.summary(scope, opts.session || 'latest');
        await ctx.sendRich(m.chat, 'log', {
          session: scope, logSession: sm.id || opts.session || '-', total: sm.total, shown: entries.length,
          title: `${entries.length} entri terakhir`, filters: filters.join(' · '), groupsMatched, entries: entries.map(row),
        }, { quoted: m.raw });
      },
    },
    {
      name: 'mlog', ownerOnly: true, usage: '.mlog [list|view|reset|del|delold|export|console]', description: 'Manajer log: reset, hapus, ekspor, pilih sesi (interactive)',
      async run(ctx, m, args) {
        const scope = ctx.session.name;
        const logs = ctx.session.logs;
        const sub = (args[0] || '').toLowerCase();
        const confirmed = args[args.length - 1] === 'yes';

        if (!sub) return panel(ctx, m);

        if (sub === 'list') {
          const page = Math.max(1, Number(args[1]) || 1);
          const list = logs.listSessions(scope);
          const slice = list.slice((page - 1) * 10, page * 10);
          if (!slice.length) return m.reply('Tidak ada sesi log di halaman ini.');
          const flow = [{
            text: `📂 Pilih sesi log (${page}/${Math.ceil(list.length / 10)})`,
            sections: [{ title: 'Sesi log', rows: slice.map((s) => ({ header: s.active ? 'AKTIF' : '', title: s.id, description: `${s.count} entri · ${U.formatBytes(s.size)}`, id: `${m.prefix}mlog view ${s.id}` })) }],
          }];
          if (page * 10 < list.length) flow.push(btn('➡️ Berikutnya', `${m.prefix}mlog list ${page + 1}`));
          flow.push(btn('⬅️ Menu', `${m.prefix}mlog`));
          return ctx.sendInteractive(m.chat, { text: `Total ${list.length} sesi log untuk *${scope}*.`, footer: 'Setiap start/restart membuat sesi log baru', nativeFlow: flow }, { quoted: m.raw });
        }

        if (sub === 'view') {
          const s = resolveSession(ctx, args[1]);
          if (!s) return m.reply('Sesi log tidak ditemukan.');
          const sm = await logs.summary(scope, s.id);
          const flow = [btn('📜 Lihat isi (.log)', `${m.prefix}log session ${s.id}`), btn('📤 Ekspor', `${m.prefix}mlog export ${s.id}`)];
          flow.push(s.active ? btn('🧹 Reset', `${m.prefix}mlog reset`) : btn('🗑️ Hapus', `${m.prefix}mlog del ${s.id}`));
          return ctx.sendInteractive(m.chat, { text: `📁 *${s.id}*${s.active ? ' (aktif)' : ''}\nEntri: ${sm.total} · ${U.formatBytes(s.size)} · ${s.files.length} file\n${LEVELS.map((l) => `${ICON[l]} ${l}: ${(sm.byLevel || {})[l] || 0}`).join('\n')}\nPesan masuk: ${sm.messagesIn} · keluar: ${sm.messagesOut} · command: ${sm.commands}`, footer: 'Sesi log', nativeFlow: flow }, { quoted: m.raw });
        }

        if (sub === 'reset') {
          if (!confirmed) return confirm(ctx, m, '🧹 Reset *sesi log aktif*? Seluruh entri sesi ini dihapus (kejadian reset tetap dicatat).', `${m.prefix}mlog reset yes`);
          const n = await logs.get(scope).reset(`BotNoi ${m.senderNumber}`);
          return panel(ctx, m, `✅ ${n} entri dihapus.`);
        }

        if (sub === 'del') {
          const s = resolveSession(ctx, args[1]);
          if (!s) return m.reply('Sesi log tidak ditemukan. Lihat: .mlog list');
          if (s.active) return m.reply('Sesi aktif tidak bisa dihapus — gunakan .mlog reset.');
          if (!confirmed) return confirm(ctx, m, `🗑️ Hapus sesi log *${s.id}* (${s.count} entri)?`, `${m.prefix}mlog del ${s.id} yes`);
          logs.deleteSession(scope, s.id);
          ctx.logger.warn({ event: 'log.deleted', session: s.id, by: m.senderNumber }, `Sesi log ${s.id} dihapus oleh BotNoi`);
          return panel(ctx, m, `✅ Sesi ${s.id} dihapus.`);
        }

        if (sub === 'delold') {
          const keep = Math.max(1, Number(args[1] && args[1] !== 'yes' ? args[1] : 3) || 3);
          const old = logs.listSessions(scope).filter((s) => !s.active).slice(keep - 1);
          if (!old.length) return m.reply(`Tidak ada sesi lama (menyimpan ${keep} terbaru).`);
          if (!confirmed) return confirm(ctx, m, `🗑️ Hapus ${old.length} sesi log lama dan simpan ${keep} terbaru (+ sesi aktif)?`, `${m.prefix}mlog delold ${keep} yes`);
          for (const s of old) logs.deleteSession(scope, s.id);
          ctx.logger.warn({ event: 'log.pruned', removed: old.length, keep, by: m.senderNumber }, `${old.length} sesi log lama dihapus`);
          return panel(ctx, m, `✅ ${old.length} sesi lama dihapus.`);
        }

        if (sub === 'export') {
          const s = resolveSession(ctx, args[1]);
          const file = await logs.exportSession(scope, s ? s.id : 'latest');
          try {
            await ctx.sendMessage(m.chat, { document: { url: file }, mimetype: 'application/json', fileName: file.split('/').pop(), caption: '📤 Ekspor log' }, { quoted: m.raw });
          } finally { fs.rm(file, { force: true }, () => {}); }
          return;
        }

        if (sub === 'console') {
          const lv = (args[1] || '').toLowerCase();
          if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(lv)) return m.reply(`Level console sekarang: ${ctx.config.core.get('logging.consoleLevel')}\n.mlog console info|warn|error|…`);
          const r = ctx.config.core.set('logging.consoleLevel', lv);
          return m.reply(r.ok ? `✅ Level log di terminal: ${lv} (file log tetap mencatat semuanya)` : `❌ ${r.error}`);
        }

        return m.reply('Subcommand: list, view, reset, del, delold, export, console');
      },
    },
  ],
};
