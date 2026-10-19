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
