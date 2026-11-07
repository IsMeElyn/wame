# WaBot — Bot WhatsApp multi-akun (Rich Message)

Node.js **CommonJS** · `@itsliaaa/baileys` · **LowDB** · **Pino** (log terstruktur per sesi) · auth terenkripsi **AES-256-GCM** · sistem plugin · Rich Message dari **template HTML**.

## Instalasi

```bash
npm install
cp .env.example .env      # isi AUTH_SECRET (disarankan)
npm start                 # menu CLI interaktif
```

Butuh Node ≥ 20. `ffmpeg` + `ffprobe` dibutuhkan untuk `.rbit`.

Opsi: `--start-all` (jalankan semua sesi autoStart) · `--start=a,b` · `--headless` (tanpa menu, untuk pm2/systemd) · `--help`.

## CLI

Saat start kamu masuk menu: daftar sesi, **buat sesi** (nama + metode **QR** atau **Pairing Code**), start / stop / restart per sesi (banyak sesi bisa tersambung bersamaan), logout & hapus sesi, ganti metode, backup / restore auth, pengaturan per akun, **pengaturan global bot**, menu plugin, monitor resource, dan penampil log.

Tiap sesi punya auth, database, dan sesi log sendiri.

## Auth terenkripsi (penting)

`src/crypto-auth.js` menggantikan `useMultiFileAuthState`:

- setiap file dienkripsi AES-256-GCM; nama file disamarkan `<hex>.wbx`; format `WBX1` bukan JSON;
- kunci diturunkan dari `AUTH_SECRET` (env) atau `data/.secret` (dibuat otomatis) + `PEPPER` di kode;
- Baileys standar / fork lain **tidak bisa** membaca folder ini, dan sebaliknya;
- creds yang tak bisa dibuka **tidak** diganti diam-diam dengan creds baru (mencegah sesi tertimpa).

> **Simpan `AUTH_SECRET` / `data/.secret` bersama backup.** Tanpa kunci yang sama, auth tidak bisa dibuka dan kamu harus pairing ulang. Ubah `PEPPER` sebelum pemakaian pertama bila ingin format unik milikmu (mengubahnya kemudian membuat auth lama tak terbaca).

Backup auth (`.wbak`, tetap terenkripsi) dibuat otomatis saat pertama tersambung dan bisa di-restore dari CLI atau `.restore`.

## Log

Semua tercatat ke LowDB: `data/logs/<sesi>/<tahun-bulan-tanggal_jam-menit-detik>.json` (pecah jadi part bila besar). Setiap start/restart membuka **sesi log baru**. Yang dicatat: pesan masuk/keluar, setiap pemanggilan `sock.*`, semua event Baileys, koneksi, creds, plugin, command, error, snapshot resource. Entri: `{seq,time,level,scope,source,event,msg,jid,group,data}`.

## Command

Prefix default `.` (bisa diubah). Mode **private** = hanya BotNoi, **public** = semua orang (kecuali command khusus BotNoi).

| Command | Fungsi |
|---|---|
| `.menu` | Daftar command (Rich) |
| `.bot on/off` · `.mode private/public` · `.cmd on/off <nama>` | Kontrol (hanya BotNoi) |
| `.setting` · `.backup` · `.restore` · `.ping` · `.uptime` | Pengaturan & info |
| `.sw <caption>` + gambar/video (atau reply) | Jadikan status WhatsApp |
| `.here <caption>` + dokumen/gambar/video/audio (atau reply) | Kirim ulang oleh BotNoi. Dokumen dikirim sebagai **video / audio / foto** sesuai mime (atau ekstensi / isi file bila mime generik); selain itu tetap dokumen |
| `.rbit [MB\|%\|1080p]` + video/dokumen video | Kompres bitrate (H.264 CRF terbatas, maks 720p) |
| `.log [n] [level] [search <kata>]` | Log terbaru (Rich) |
| `.log search <inisial grup>` | Aktivitas grup tersebut |
| `.mlog` | Manajer log (interaktif): lihat, reset, hapus, ekspor |
| `.statistik` | Statistik bot & log (Rich) |
| `.cekgc <inisial grup>` | Data lengkap grup + anggota (Rich). 1 hasil → langsung; >1 hasil mirip → **pesan interaktif** untuk memilih grup |
| `.catur` | Kirim **catur.html** (HTML+CSS+JS satu file) — buka di browser, main dengan ketuk bidak: lawan AI / berdua, undo, saran, putar papan |
| `.plugin …` · `.update` | Kelola plugin; perbarui file tanpa restart |

`.log`, `.mlog`, `.cekgc` khusus BotNoi (privasi). Jika Rich Message tidak tampil di klien, `.setting rich off` memakai teks biasa.

## Catur (HTML)

`.catur` mengirim satu file `catur.html` yang dirakit dari `web/chess.html` (UI) + `lib/chess.js` (engine, ditanam di dalam file). Semua jalan di browser pemain — tanpa command langkah, tanpa state di bot. Game tersimpan otomatis di browser (localStorage). AI berjalan di Web Worker.
Tips: di Android/desktop buka dengan Chrome/Firefox. Di iOS, pratinjau WhatsApp biasanya tidak menjalankan JavaScript — simpan ke *Files* lalu buka lewat browser, atau mainkan dari desktop.

## Plugin

Taruh file `.js` di `plugins/`. Contoh:

```js
module.exports = {
  name: 'halo', version: '1.0.0', description: 'Contoh',
  dependencies: { 'core-admin': '>=1.0.0' },
  config: { defaults: { sapaan: 'Halo' }, schema: { sapaan: { type: 'string' } } },
  commands: [{
    name: 'halo', usage: '.halo', description: 'Menyapa',
    async run(ctx, m, args) { await m.reply(`${ctx.config.get('sapaan')}!`); },
  }],
  events: { 'message.received'(ctx, p) { /* … */ } },
  async start(ctx) {}, async stop(ctx) {},
  async onConnected(ctx) {}, async onDisconnected(ctx, info) {},
};
```

Modul plugin dipakai bersama semua akun — **jangan simpan state di level modul**; pakai `ctx.state` atau `ctx.database`.

`ctx`: `sock`, `sendMessage`, `send` (text/image/video/audio/document/location/reply/delete/edit…), `sendRich`, `sendInteractive`, `logger`, `config`, `database`, `events`, `auth`, `utils`, `plugins`, `groups`, `timers`, `session`, `canRun`.
Event internal: `message.received/sent/update/delete`, `group.participants.update`, `group.metadata.update`, `connection.update`, `creds.update`, `command.executed`, `plugin.started`, dll. Listener & timer dibersihkan otomatis saat plugin di-stop/reload.

Validasi struktur, deteksi duplikat, dependensi + versi (semver), isolasi error, dan status plugin ada di `src/plugin-manager.js`.

## Template HTML → Rich Message

Markup ada di `views/*.html`, bukan di JS. Render: `ctx.sendRich(jid, 'nama-view', vars)`.

Tag: `h1–h6 p ul/ol/li hr br blockquote pre[lang] table[title]/tr/th/td include[name]`, inline `b i s code a`.
Logika: `<for each="x" as="i" limit="N">`, `<if test|not|eq>`, `<unless>`. Variabel: `{{path|filter}}` (`upper lower trunc:N num date time dur pad:N default:x len json`).
Hasilnya `richResponse` Baileys + teks cadangan.

## Hot reload

Tanpa restart: `plugins/`, `lib/`, serta modul router, messages, rich, groups, stats. Butuh restart: `session`, `manager`, `logger`, `db`, `crypto-auth`, `cli`. `.update` menerapkan file yang dikirim dengan cek sintaks, backup, dan rollback.

## Konfigurasi

Urutan: **ENV > pengaturan tersimpan (CLI/`.setting`) > default** (`src/config.js`, tervalidasi). ENV: `AUTH_SECRET`, `BOT_NAME`, `BOT_PREFIX`, `BOT_MODE`, `LOG_CONSOLE_LEVEL`, `LOG_BAILEYS_LEVEL`, `BOT_BACKUP_ON_CONNECT`, `BOT_HOT_RELOAD`, `BOT_DATA_DIR`.

## Tes

`npm test` — memakai **stub offline** untuk baileys/pino/lowdb: menguji enkripsi auth, template, permission router, plugin manager, alur command (`.sw`, `.here`, `.rbit` dengan ffmpeg sungguhan), log, restart, logout. Tes ini **tidak** membuktikan kompatibilitas dengan paket asli atau server WhatsApp.
