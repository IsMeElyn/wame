'use strict';
/** .cekgc <inisial/nama grup> — data lengkap grup: info, pengaturan, admin, aktivitas log, dan seluruh anggota. */
const U = require('../src/utils');

const PAGE = 50;
const yn = (v) => (v ? 'Ya' : 'Tidak');

module.exports = {
  name: 'groupinfo',
  version: '1.0.0',
  description: 'Cek data lengkap grup berdasarkan nama/inisial',
  category: 'Grup',
  commands: [
    {
      name: 'cekgc', ownerOnly: true, usage: '.cekgc <inisial nama grup> [nomor]', description: 'Data lengkap grup (anggota, admin, pengaturan, aktivitas)',
      async run(ctx, m, args) {
        if (args[0] === 'refresh') { const n = await ctx.groups.refresh(); return m.reply(`✅ Cache ${n} grup diperbarui.`); }
        let pickN = 1;
        if (args.length > 1 && /^\d+$/.test(args[args.length - 1])) pickN = Number(args.pop());
        const query = args.join(' ').trim();
        if (!query) return m.reply(`Gunakan: .cekgc <inisial/nama grup>\nContoh: .cekgc dtl\nGrup dikenal: ${ctx.groups.list().length} (.cekgc refresh untuk sinkron)`);

        const found = ctx.groups.find(query);
        if (!found.length) return m.reply(`❌ Tidak ada grup yang cocok dengan "${query}". Coba .cekgc refresh.`);
        if (found.length > 1 && args.length && pickN === 1 && !(found[0].subject.toLowerCase() === query.toLowerCase())) {
          return ctx.sendRich(m.chat, 'cekgc-pick', { query, groups: found.slice(0, 15).map((g, i) => ({ n: i + 1, subject: g.subject, size: g.size })) }, { quoted: m.raw });
        }
        const chosen = found[pickN - 1];
        if (!chosen) return m.reply(`Nomor ${pickN} tidak ada (ada ${found.length} hasil).`);

        let g;
        try { g = await ctx.groups.metadata(chosen.id, { force: true }); } catch { g = chosen; }
        const members = await ctx.groups.members(g.id, { maxAgeMs: Infinity });
        const admins = members.filter((x) => x.isAdmin);
        const st = ctx.session.stats().perChat[g.id];
        const owner = members.find((x) => x.jid === g.owner || x.number === U.jidUser(g.owner || '')) || null;
        const activity = (await ctx.session.logs.query(ctx.session.name, { jid: g.id, limit: 6 })).map((e) => ({ time: U.formatTime(e.time), msg: U.truncate(String(e.msg ?? e.event).replace(/\s+/g, ' '), 90) }));

        await ctx.sendRich(m.chat, 'cekgc', {
          g: { subject: g.subject, desc: g.desc },
          info: [
            { k: 'ID', v: g.id }, { k: 'Dibuat', v: g.creation ? U.formatDateTime(g.creation * 1000) : '-' },
            { k: 'Pembuat', v: owner ? `${owner.name || owner.number}` : g.owner ? U.jidUser(g.owner) : '-' },
            { k: 'Anggota', v: members.length }, { k: 'Admin', v: admins.length },
            { k: 'Pesan tercatat (bot)', v: st ? `masuk ${st.in} · keluar ${st.out}` : 'belum ada' },
            { k: 'Aktivitas terakhir', v: st && st.lastAt ? U.formatDateTime(st.lastAt) : '-' },
            { k: 'Data diperbarui', v: U.formatDateTime(g.updatedAt || Date.now()) },
          ],
          settings: [
            { k: 'Kirim pesan', v: g.announce ? 'Hanya admin' : 'Semua anggota' },
            { k: 'Edit info grup', v: g.restrict ? 'Hanya admin' : 'Semua anggota' },
            { k: 'Tambah anggota', v: g.memberAddMode === 'admin_add' ? 'Hanya admin' : g.memberAddMode ? 'Semua anggota' : '-' },
            { k: 'Persetujuan gabung', v: yn(g.joinApprovalMode) }, { k: 'Pesan sementara', v: g.ephemeralDuration ? `${Math.round(g.ephemeralDuration / 86400)} hari` : 'Nonaktif' },
            { k: 'Komunitas', v: yn(g.isCommunity || g.isCommunityAnnounce || g.linkedParent) },
          ],
          admins: admins.map((a) => ({ name: U.truncate(a.name || '-', 24), number: a.number, role: a.role })), adminCount: admins.length,
          activity, memberCount: members.length,
        }, { quoted: m.raw });

        const sorted = [...members].sort((a, b) => (b.isAdmin - a.isAdmin) || a.number.localeCompare(b.number));
        const pages = Math.min(5, Math.ceil(sorted.length / PAGE));
        for (let p = 0; p < pages; p++) {
          const slice = sorted.slice(p * PAGE, (p + 1) * PAGE);
          await ctx.sendRich(m.chat, 'cekgc-members', {
            subject: g.subject, page: p + 1, pages, from: p * PAGE + 1, to: p * PAGE + slice.length,
            members: slice.map((x, i) => ({ n: p * PAGE + i + 1, name: U.truncate(x.name || '-', 22), number: x.number, role: x.role })),
          });
        }
        if (sorted.length > PAGE * 5) await m.reply(`ℹ️ Daftar anggota dipotong ${PAGE * 5} dari ${sorted.length}.`);
      },
    },
  ],
};
