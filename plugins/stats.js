'use strict';
/** .statistik — ringkasan lengkap bot (koneksi, trafik, resource, log, plugin) sebagai Rich Message. */
const U = require('../src/utils');
const monitor = require('../src/monitor');

const kv = (k, v) => ({ k, v: String(v) });

module.exports = {
  name: 'stats',
  version: '1.0.0',
  description: 'Statistik lengkap bot dan log',
  category: 'Info',
  commands: [
    {
      name: 'statistik', aliases: ['stats', 'stat'], usage: '.statistik', description: 'Statistik lengkap bot: log, trafik, resource, plugin',
      async run(ctx, m) {
        const s = ctx.session.raw;
        const st = s.db.data.stats;
        const res = monitor.peek();
        const sm = await ctx.session.logs.summary(s.name);
        const plugins = ctx.plugins.list();
        const backups = ctx.auth.backups();
        const owner = m.isBotNoi;

        const days = Object.keys(st.perDay).sort().slice(-7).reverse().map((d) => ({ date: d, ...st.perDay[d] }));
        const topCommands = Object.entries(st.commands).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name: `.${name}`, count }));
        const topChats = owner ? Object.entries(st.perChat).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out)).slice(0, 6).map(([jid, c]) => ({ name: U.truncate(c.name || U.jidUser(jid), 28), in: c.in, out: c.out })) : [];

        await ctx.sendRich(m.chat, 'stats', {
          bot: [
            kv('Akun', `${s.name} (${s.info.method})`), kv('Nomor BotNoi', owner ? U.jidUser(s.botJid) : '••••'), kv('Status', s.status),
            kv('Mode / Prefix', `${ctx.session.mode} / ${ctx.session.prefix}`), kv('Command', ctx.session.settings().commandsEnabled === false ? 'OFF' : 'ON'),
            kv('Tersambung', U.formatDuration(ctx.session.uptimeMs)), kv('Koneksi', `buka ${st.connections.opened} · tutup ${st.connections.closed} · reconnect ${st.connections.reconnects}`),
            kv('Grup / Kontak dikenal', `${ctx.groups.list().length} / ${Object.keys(s.db.data.contacts).length}`),
            kv('Backup auth', backups.length ? `${backups.length} (terakhir ${backups[0].id})` : 'belum ada'),
          ],
          traffic: [
            kv('Pesan masuk', st.messagesReceived.toLocaleString('id-ID')), kv('Pesan keluar', st.messagesSent.toLocaleString('id-ID')),
            kv('Command dijalankan', st.commandsRun), kv('Command error', st.commandErrors), kv('Statistik sejak', st.firstSeenAt ? U.formatDateTime(st.firstSeenAt) : '-'),
          ],
          resource: [
            kv('Uptime proses', U.formatDuration(res.uptimeMs)), kv('Memori (RSS)', U.formatBytes(res.rss)), kv('Heap', `${U.formatBytes(res.heapUsed)} / ${U.formatBytes(res.heapTotal)}`),
            kv('CPU proses', `${res.cpuPercent}% · load ${res.loadAvg.join(' ')}`), kv('RAM sistem bebas', `${U.formatBytes(res.freeMem)} / ${U.formatBytes(res.totalMem)}`), kv('Node', `${res.node} · ${res.platform}`),
          ],
          logs: [
            kv('Sesi log', sm.id), kv('Total entri', sm.total.toLocaleString('id-ID')),
            kv('Per level', ['info', 'warn', 'error', 'fatal'].map((l) => `${l}:${(sm.byLevel || {})[l] || 0}`).join(' ')),
            kv('Pesan dicatat', `masuk ${sm.messagesIn} · keluar ${sm.messagesOut}`),
            kv('Sumber teratas', Object.entries(sm.bySource || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(' ')),
          ],
          days, topCommands, topChats,
          plugins: plugins.map((p) => ({ name: p.name, version: p.version, state: p.state, errors: p.errors })),
        }, { quoted: m.raw });
      },
    },
  ],
};
