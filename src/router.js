'use strict';
/**
 * Router command (hot-reloadable). Aturan akses:
 *  - bot OFF   : semua command non-`control` diabaikan untuk SEMUA orang. Command `control` hanya BotNoi.
 *  - private   : hanya BotNoi (nomor yang terhubung) yang bisa memakai command.
 *  - public    : semua orang, kecuali command `ownerOnly`/`control` (khusus BotNoi).
 *  - command bisa dimatikan satuan (`.cmd off <nama>`), hanya BotNoi yang tetap dapat jawaban.
 */
const hot = require('./hot');
const stats = require('./stats');

const cooldowns = new Map(); // `${session}|${sender}` -> ts

function decide(session, m, hit) {
  const s = session.db.data.settings;
  const { cmd } = hit;
  const bot = m.isBotNoi;
  if (cmd.control && !bot) return { ok: false, silent: true, reason: 'control_only_botnoi' };
  if (s.commandsEnabled === false && !cmd.control) return { ok: false, silent: true, reason: 'bot_off' };
  if (session.getMode() === 'private' && !bot) return { ok: false, silent: true, reason: 'mode_private' };
  if (cmd.ownerOnly && !bot) return { ok: false, silent: false, reason: 'owner_only', reply: '⛔ Command ini khusus BotNoi.' };
  if (!cmd.control && (s.disabledCommands || []).includes(cmd.name)) {
    return bot ? { ok: false, silent: false, reason: 'cmd_disabled', reply: `⛔ Command .${cmd.name} sedang dinonaktifkan (.cmd on ${cmd.name}).` } : { ok: false, silent: true, reason: 'cmd_disabled' };
  }
  if (cmd.groupOnly && !m.isGroup) return { ok: false, silent: false, reason: 'group_only', reply: 'ℹ️ Command ini hanya untuk grup.' };
  if (cmd.privateOnly && m.isGroup) return { ok: false, silent: false, reason: 'private_only', reply: 'ℹ️ Command ini hanya untuk chat pribadi.' };
  return { ok: true };
}

/** Dipakai plugin untuk memutuskan apakah pesan non-prefix (mis. langkah catur) boleh diproses. */
function canRun(session, m, cmdName) {
  const s = session.db.data.settings;
  if (m.isBotNoi) return s.commandsEnabled !== false || false;
  if (s.commandsEnabled === false) return false;
  if (session.getMode() !== 'public') return false;
  if (cmdName && (s.disabledCommands || []).includes(cmdName)) return false;
  return true;
}

async function handle(session, m) {
  if (!m.isCommand) return false;
  const log = session.logger;
  const hit = session.plugins.findCommand(m.command);
  if (!hit) {
    log.debug({ event: 'command.unknown', jid: m.chat, command: m.command, sender: m.senderNumber }, `Command tidak dikenal: ${m.command}`);
    return false;
  }
  const verdict = decide(session, m, hit);
  if (!verdict.ok) {
    log.info({ event: 'command.denied', jid: m.chat, command: hit.cmd.name, sender: m.senderNumber, reason: verdict.reason }, `Command .${hit.cmd.name} ditolak (${verdict.reason})`);
    if (!verdict.silent && verdict.reply) await m.reply(verdict.reply).catch(() => {});
    return true;
  }
  if (!m.isBotNoi) {
    const cd = session.manager.config.get('bot.cooldownMs');
    const k = `${session.name}|${m.sender}`;
    const last = cooldowns.get(k) || 0;
    if (Date.now() - last < cd) {
      log.debug({ event: 'command.cooldown', jid: m.chat, command: hit.cmd.name, sender: m.senderNumber }, 'Command diabaikan (cooldown)');
      return true;
    }
    cooldowns.set(k, Date.now());
  }

  const started = Date.now();
  const entry = hit.entry;
  const r = await session.plugins.invoke(entry, `cmd:${hit.cmd.name}`, () => hit.cmd.run(entry.ctx, m, m.args));
  const ms = Date.now() - started;
  stats.recordCommand(session, hit.cmd.name, r.ok);
  log.info({
    event: 'command.executed', jid: m.chat, group: m.isGroup ? session.groupName(m.chat) : undefined, command: hit.cmd.name,
    plugin: entry.name, sender: m.senderNumber, ok: r.ok, ms, args: m.argText.slice(0, 200),
  }, `Command .${hit.cmd.name} ${r.ok ? 'selesai' : 'GAGAL'} (${ms}ms) oleh ${m.senderNumber}`);
  session.bus.emit('command.executed', { command: hit.cmd.name, plugin: entry.name, ok: r.ok, ms, chat: m.chat, sender: m.sender });
  if (!r.ok) await m.reply(`⚠️ Terjadi error pada plugin *${entry.name}* (.${hit.cmd.name}):\n${r.error.message}`).catch(() => {});
  return true;
}

module.exports = { handle, canRun, decide };
void hot;
