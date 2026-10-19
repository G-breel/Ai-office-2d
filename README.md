# Keylox AI Office — 2D Pixel Office

Kantor pixel-art 2D yang **hidup mengikuti aktivitas AI agent OpenCode** lu beneran.

- Tiap sesi OpenCode = 1 karakter di kantor.
- Kalau sesi lagi jalanin tool → karakter jalan ke meja & kerja.
- Kalau sesi nganggur → karakter istirahat di sofa/beanbag.
- Kalau nganggur kelamaan (> 30 menit) → karakter pulang (jalan ke pintu & hilang, balik lagi pas sesinya aktif).

Tampilannya top-down pixel art, palette & UI ngikut style app Keylox (`#1a1a1a` / `#ff6600`).

## Demo

- **LIVE** — karakter digerakin aktivitas OpenCode beneran (default kalau bridge nyala).
- **DEMO** — simulasi jalan sendiri (buat ngetes tampilan tanpa OpenCode).

## Kebutuhan

- Node.js **≥ 22** (pakai `node:sqlite` built-in — gak perlu `npm install`)
- OpenCode terpasang & lagi jalan (buat mode LIVE)
- Browser modern (Chrome / Edge / Firefox)

## Quick start

```bash
git clone https://github.com/G-breel/Ai-office-2d.git
cd Ai-office-2d

# 1. nyalain bridge (baca DB OpenCode, read-only)
node keylox_office_bridge.mjs --open

# 2. browser auto kebuka ke http://127.0.0.1:4399/
```

Kalau mau buka manual: `http://127.0.0.1:4399/`.

> Bridge cuma **baca** database OpenCode (`query_only`), gak nulis apa pun.

## Cara kerja

1. Bridge polling `session_v2` + `session_message` tiap 1 detik.
2. Tiap sesi yang aktif ≤ 6 jam terakhir → 1 karakter (maks 6 karakter di kantor).
3. State sesi:
   - `working` — ada tool yang lagi `running` atau pesan masih `streaming` (≤ 25s terakhir) → jalan ke meja
   - `resting` — diem sebentar → jalan ke sofa/beanbag
   - `away` — diem > 30 menit → jalan ke pintu & hilang
4. Label task-nya asli dari tool: `bash: npm run build`, `edit: Timeline.tsx`, `grep: session_v2`, dst.

## Kontrol

| Aksi | Cara |
|---|---|
| Pause / lanjut | tombol `⏸ Pause` atau `Space` |
| Kecepatan | `1x` / `2x` / `4x` |
| Mode | tombol `● LIVE` / `DEMO` |
| Pilih agent | klik karakter / kartu / `1`–`6` |
| Suruh jalan ke titik | klik lantai (mode DEMO) |
| Semua kerja | `W` atau tombol (DEMO) |
| Semua istirahat | `R` atau tombol (DEMO) |
| Perintah bebas | ketik di kotak perintah, mis. `reno kerja`, `maya istirahat`, `semua istirahat` |

Di mode LIVE, tombol manual mati — karakter dikontrol aktivitas OpenCode.

## Opsi bridge (CLI)

```
node keylox_office_bridge.mjs [opsi]

  --port <n>        port server (default 4399)
  --poll <ms>       interval polling DB (default 1000)
  --max <n>         maks sesi yang ditampilkan (default 8)
  --rest-after <ms> diem > ini = istirahat (default 6000)
  --away-after <ms> diem > ini = pulang (default 1800000)
  --stream-max <ms> pesan streaming dianggap mati kalau > ini (default 25000)
  --tool-max <ms>   tool 'running' dianggap mati kalau > ini (default 600000)
  --project <str>   filter sesi by substring worktree
  --db <path>       path DB OpenCode (default auto-detect)
  --fake            mode demo (sesi palsu, buat ngetes UI)
  --open            buka browser otomatis
  --quiet           gak cetak log tiap poll
```

## Kustomisasi (buat ganti jadi punya lu)

Semua bisa diubah tanpa install dependency. Edit file, save, refresh browser.

### 1. Ganti warna / tema

Di `keylox_office.html`, atas file, blok `:root`:
```css
:root{
  --bg-app:#1a1a1a; --bg-panel:#222; --bg-elev:#2a2a2a;
  --accent:#ff6600;  /* warna aksen (tombol, outline karakter terpilih) */
  ...
}
```
Ganti `--accent` buat ubah warna highlight. Background kantor ada di `drawFloor()` (cari `#22222b`, `#25252f`).

### 2. Ganti karakter (nama, role, warna baju)

Di `keylox_office.html`, cari `AGENT_DEFS`:
```js
const AGENT_DEFS = [
  { name: 'Reno',  role: 'Render & Export', c: { skin:'#f2c9a0', hair:'#3a2a20', shirt:'#ff6600', pants:'#2b2f45' } },
  ...
];
```
- `name` = nama default (mode DEMO)
- `role` = jabatan yang tampil di kartu
- `c` = warna pixel karakter (skin, rambut, baju, celana)
- Tambah baris baru = karakter baru (jangan lupa tambah spawn point di `SPAWN`)

### 3. Ganti layout kantor / furniture

Di `keylox_office.html`, bagian `/* --- layout kantor --- */`:
```js
makeDesk(8, 6); makeDesk(14, 6); makeDesk(20, 6);   // 3 meja, 2 kursi per meja
addF('sofa', 25, 16, 3, 1, { blocked:false, ... }); // sofa lounge
```
- `makeDesk(x, y)` = meja kerja + 2 kursi
- `addF(kind, x, y, w, h)` = furniture (lihat daftar `kind` di `drawFurniture`)
- `blockRect` otomatis nge-block tile yang gak bisa dilewati

### 4. Ganti nama agent di mode LIVE

Nama agent LIVE diambil dari field `agent` di DB OpenCode (`data.agent`), mis. `build`, `senior-developer`. Buat ubah jadi nama yang lebih friendly, edit fungsi `prettifyAgent()` di `keylox_office_bridge.mjs`:
```js
function prettifyAgent(a) {
  // contoh: ganti 'build' jadi 'Budi'
  if (a === 'build') return 'Budi';
  ...
}
```
Atau filter sesi tertentu pakai `--project keylox` (cumulative substring).

### 5. Ganti label task (apa yang ditulis di gelembung)

Di `keylox_office_bridge.mjs`, fungsi `describeTool()`:
```js
case 'bash': case 'shell': return 'bash: ' + short(cmd, 44);
case 'edit': return 'edit: ' + baseName(input.filePath);
```
Tambah/ubah case buat tool baru.

### 6. Ganti threshold (kapan istirahat / pulang)

Lewat CLI (gak perlu edit kode):
```bash
node keylox_office_bridge.mjs --rest-after 10000 --away-after 600000
```
Atau edit konstanta di atas file bridge.

### 7. Ganti port / DB path

```bash
node keylox_office_bridge.mjs --port 5000 --db C:/path/ke/opencode.db
```
Atau env var `OPENCODE_DB` / `KEYLOX_OFFICE_PORT`.

### 8. Tambah karakter (lebih dari 6)

1. Tambah spawn point di `SPAWN` array (HTML)
2. Tambah entry di `AGENT_DEFS` (HTML)
3. Bridge udah support sampai 8 sesi (`--max 8`), naikkan kalau mau lebih

## Tips pakai dengan AI lain (Cursor, Claude Code, Aider, dll.)

Bridge baca **DB OpenCode**. Kalau lu pakai AI lain:
- **Cursor / Windsurf / Claude Code** → mereka punya DB/log sendiri; lu harus bikin bridge sendiri yang baca log mereka, atau kirim event ke endpoint `/state` manual.
- **Cara paling gampang (universal)**: bikin script kecil yang POST ke `http://127.0.0.1:4399/state`? Gak bisa (bridge read-only). Tapi lu bisa bikin bridge sendiri yang serve `/state` dengan format yang sama:
  ```json
  { "sessions": [ { "id":"x", "name":"Agent", "state":"working", "task":"edit: foo.ts", "title":"...", "project":"..." } ] }
  ```
  Format lengkap ada di `buildState()` di `keylox_office_bridge.mjs`.

## Struktur file

```
.
├── keylox_office.html        # halaman kantor (standalone, tanpa dependency)
├── keylox_office_bridge.mjs  # bridge Node.js (baca DB OpenCode)
├── package.json
└── README.md
```

## Troubleshooting

- **"DB OpenCode gak ketemu"** → set `OPENCODE_DB=/path/ke/opencode.db` atau pakai `--db`.
- **Tab hidden → animasi berhenti** → normal (browser pause `requestAnimationFrame` kalau tab tak terlihat). Pakai `KeyloxOffice.step(1/60, 600)` dari console buat fast-forward.
- **Sesi lama gak muncul** → bridge cuma ambil sesi ≤ 6 jam terakhir & yang paling baru.
- **Port 4399 dipakai** → `--port 5000`.

## Debug hook (console)

```js
KeyloxOffice.agents[0].state
KeyloxOffice.sendToDesk(KeyloxOffice.agents[0], 'task custom')
KeyloxOffice.step(1/60, 600)   // fast-forward 10 detik
KeyloxOffice.state()
KeyloxOffice.live              // state terakhir dari bridge
```

## Lisensi

MIT — bebas dipakai, dimodif, didistribusi. Kredit ke [G-breel](https://github.com/G-breel) dihargai.
