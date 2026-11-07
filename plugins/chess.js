'use strict';
/**
 * .catur — catur berbasis HTML. Bot mengirim satu file `catur.html` (HTML + CSS + JS, engine dari lib/chess.js
 * ikut ditanam di dalamnya) yang dibuka di browser lalu dimainkan langsung dengan klik/ketuk bidak.
 * Tidak ada command langkah (.m / e2e4) dan tidak ada state game di bot.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER = '/*__ENGINE__*/';

/** Gabungkan template web/chess.html dengan engine lib/chess.js menjadi satu file mandiri (dibaca ulang tiap pemanggilan → hot-reload). */
function buildPage() {
  const tpl = fs.readFileSync(path.join(ROOT, 'web', 'chess.html'), 'utf8');
  const engine = fs.readFileSync(path.join(ROOT, 'lib', 'chess.js'), 'utf8');
  if (!tpl.includes(PLACEHOLDER)) throw new Error('web/chess.html tidak memuat penanda engine');
  if (/<\/script/i.test(engine)) throw new Error('lib/chess.js tidak boleh memuat "</script"');
  return Buffer.from(tpl.replace(PLACEHOLDER, () => engine), 'utf8');
}

module.exports = {
  name: 'chess',
  version: '2.0.0',
  description: 'Catur HTML: bot mengirim file catur.html yang dimainkan di browser (vs AI / berdua)',
  category: 'Game',
  commands: [
    {
      name: 'catur', aliases: ['chess'], usage: '.catur', description: 'Kirim game catur (file HTML) — buka di browser lalu main',
      async run(ctx, m) {
        const html = buildPage();
        await ctx.sendMessage(m.chat, {
          document: html,
          mimetype: 'text/html',
          fileName: 'catur.html',
          caption: '♟️ *Catur*\nBuka file ini dengan browser (Chrome/Safari/Firefox), lalu main langsung dengan ketuk bidak.\n• Lawan AI (mudah/normal/sulit) atau berdua dalam satu layar\n• Undo, saran langkah, putar papan\n• Game tersimpan otomatis di browser',
        }, { quoted: m.raw });
      },
    },
  ],
};
