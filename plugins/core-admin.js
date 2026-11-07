'use strict';
/** Command dasar & kontrol bot oleh BotNoi: menu, ping, uptime, bot on/off, mode private/public, cmd on/off, setting, backup, restore. */
const U = require('../src/utils');

const bool = (s) => (/^(on|1|ya|true|aktif)$/i.test(s) ? true : /^(off|0|tidak|false|nonaktif)$/i.test(s) ? false : null);

module.exports = {
  name: 'core-admin',
  version: '1.0.0',
  description: 'Menu, ping, kontrol bot (on/off, private/public), toggle command, backup/restore auth',
  category: 'Admin',
  commands: [
    {
      name: 'menu', aliases: ['help', 'start'], usage: '.menu', description: 'Daftar semua command',
      async run(ctx, m) {
        const isOwner = m.isBotNoi;
        const cmds = ctx.plugins.commands().filter((c) => isOwner || (!c.ownerOnly && !c.control));
        const groups = new Map();
        for (const c of cmds) {
          const k = c.category || c.plugin;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push({ usage: c.usage || `.${c.name}`, description: c.description });
        }
        const s = ctx.session.settings();
        await ctx.sendRich(m.chat, 'menu', {
          mode: ctx.session.mode, prefix: ctx.session.prefix, state: s.commandsEnabled === false ? 'OFF' : 'ON',
          categories: [...groups].map(([name, c]) => ({ name, cmds: c })),
        }, { quoted: m.raw });
      },
    },
    {
      name: 'ping', usage: '.ping', description: 'Cek respons bot',
      async run(ctx, m) {
        const t = Date.now();
        const lat = Math.max(0, t - m.timestamp);
        await m.reply(`🏓 Pong! Latensi ±${lat}ms · uptime koneksi ${U.formatDuration(ctx.session.uptimeMs)}`);
      },
    },
    {
      name: 'uptime', usage: '.uptime', description: 'Lama bot tersambung',
      async run(ctx, m) {
        await m.reply(`⏱️ Tersambung: ${U.formatDuration(ctx.session.uptimeMs)}\n🖥️ Proses: ${U.formatDuration(process.uptime() * 1000)}`);
      },
    },
    {
      name: 'bot', control: true, ownerOnly: true, usage: '.bot on|off', description: 'Hidup/matikan semua command (kecuali kontrol)', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        const s = ctx.session.settings();
        const v = bool(args[0] || '');
        if (v === null) return m.reply(`🤖 Command: *${s.commandsEnabled === false ? 'OFF' : 'ON'}* · Mode: *${ctx.session.mode}*\nGunakan: .bot on | .bot off`);
        s.commandsEnabled = v;
        ctx.database.save();
        ctx.session.raw.db.save();
        ctx.logger.warn({ event: 'bot.toggle', value: v, by: m.senderNumber }, `Command ${v ? 'DIAKTIFKAN' : 'DIMATIKAN'} oleh BotNoi`);
        await m.reply(v ? '✅ Command diaktifkan.' : '⛔ Semua command dimatikan. Hanya command kontrol (.bot, .mode, .cmd, .plugin, .setting) yang tetap jalan untuk BotNoi.');
      },
    },
    {
      name: 'mode', control: true, ownerOnly: true, usage: '.mode private|public', description: 'private = hanya BotNoi, public = semua orang', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        const a = (args[0] || '').toLowerCase();
        if (!['private', 'public'].includes(a)) return m.reply(`🔐 Mode sekarang: *${ctx.session.mode}*\nGunakan: .mode private | .mode public`);
        ctx.session.settings().mode = a;
        ctx.session.raw.db.save();
        ctx.logger.warn({ event: 'bot.mode', value: a, by: m.senderNumber }, `Mode command → ${a}`);
        await m.reply(a === 'private' ? '🔒 Mode *private*: hanya BotNoi yang bisa memakai command.' : '🌐 Mode *public*: semua orang bisa memakai command (kecuali yang khusus BotNoi).');
      },
    },
    {
      name: 'cmd', control: true, ownerOnly: true, usage: '.cmd list|on|off <nama>', description: 'Aktif/nonaktifkan command satuan', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        const s = ctx.session.settings();
        const sub = (args[0] || 'list').toLowerCase();
        const all = ctx.plugins.commands();
        if (sub === 'list') {
          const off = s.disabledCommands || [];
          const lines = all.filter((c) => !c.control).map((c) => `${off.includes(c.name) ? '⛔' : '✅'} .${c.name}`);
          return m.reply(`*Status command*\n${lines.join('\n')}\n\n.cmd off <nama> · .cmd on <nama>`);
        }
        const target = (args[1] || '').toLowerCase().replace(/^\./, '');
        const found = all.find((c) => c.name === target || c.aliases.includes(target));
        if (!['on', 'off'].includes(sub) || !found) return m.reply('Gunakan: .cmd on <nama> | .cmd off <nama> | .cmd list');
        if (found.control) return m.reply('⛔ Command kontrol tidak bisa dimatikan.');
        const set = new Set(s.disabledCommands || []);
        if (sub === 'off') set.add(found.name); else set.delete(found.name);
        s.disabledCommands = [...set];
        ctx.session.raw.db.save();
        ctx.logger.warn({ event: 'cmd.toggle', command: found.name, value: sub, by: m.senderNumber }, `Command .${found.name} → ${sub}`);
        await m.reply(`${sub === 'on' ? '✅' : '⛔'} .${found.name} ${sub === 'on' ? 'diaktifkan' : 'dinonaktifkan'}.`);
      },
    },
    {
      name: 'setting', aliases: ['set'], control: true, ownerOnly: true, usage: '.setting rich|prefix <nilai>', description: 'Ubah rich message / prefix akun ini', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        const s = ctx.session.settings();
        const [k, v] = [(args[0] || '').toLowerCase(), args[1]];
        if (k === 'rich') {
          const b = bool(v || '');
          if (b === null) return m.reply(`Rich Message: *${s.richEnabled === false ? 'OFF' : 'ON'}*\n.setting rich on|off`);
          s.richEnabled = b; ctx.session.raw.db.save();
          return m.reply(`✨ Rich Message ${b ? 'diaktifkan' : 'dimatikan (kirim teks biasa)'}.`);
        }
        if (k === 'prefix') {
          if (!v || v.length > 3) return m.reply(`Prefix sekarang: *${ctx.session.prefix}*\n.setting prefix <1-3 karakter>`);
          s.prefix = v; ctx.session.raw.db.save();
          return m.reply(`✅ Prefix diubah menjadi *${v}* (gunakan ${v}menu)`);
        }
        await m.reply(`⚙️ Pengaturan akun\n• Mode: ${ctx.session.mode}\n• Prefix: ${ctx.session.prefix}\n• Rich: ${s.richEnabled === false ? 'OFF' : 'ON'}\n• Command: ${s.commandsEnabled === false ? 'OFF' : 'ON'}\n\n.setting rich on|off · .setting prefix <x> · .mode · .bot`);
      },
    },
    {
      name: 'backup', control: true, ownerOnly: true, usage: '.backup [list]', description: 'Backup auth sekarang / lihat daftar', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        if ((args[0] || '') === 'list') {
          const l = ctx.auth.backups().slice(0, 10);
          return m.reply(l.length ? `💾 *Backup auth*\n${l.map((b) => `• ${b.id} (${U.formatBytes(b.bytes)})`).join('\n')}\n\nRestore: .restore <id>` : 'Belum ada backup.');
        }
        const r = await ctx.auth.backup('manual');
        await m.reply(`✅ Backup dibuat: ${r.id}\n${r.files} file · ${U.formatBytes(r.bytes)}`);
      },
    },
    {
      name: 'restore', control: true, ownerOnly: true, usage: '.restore <id>', description: 'Restore auth dari backup (sesi restart)', category: 'Kontrol (BotNoi)',
      async run(ctx, m, args) {
        const id = args[0];
        const l = ctx.auth.backups();
        if (!id) return m.reply(`Pilih backup:\n${l.slice(0, 10).map((b) => `• ${b.id}`).join('\n') || '(kosong)'}\n\n.restore <id>`);
        const b = l.find((x) => x.id === id || x.id.startsWith(id));
        if (!b) return m.reply('Backup tidak ditemukan.');
        await m.reply(`♻️ Restore dari ${b.id}… sesi akan restart & tersambung kembali sebentar lagi.`);
        const mgr = ctx.session.manager; const name = ctx.session.name; const log = ctx.logger;
        setTimeout(() => mgr.restoreAuth(name, b.id).catch((e) => log.error({ event: 'restore.failed', err: e }, e.message)), 500);
      },
    },
  ],
};
