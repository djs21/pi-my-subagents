# Scout Report: Sub-agent Gagal Berjalan di Environment Tmux

## Ringkasan Issue

Sub-agent yang di-spawn dari pi gagal berjalan atau berfungsi dengan benar ketika pi dijalankan di dalam **tmux** terminal multiplexer. Issue ini mencakup beberapa kategori kegagalan:

1. **Pane spawning di window yang salah** — sub-agent muncul di tmux window yang berbeda dari window utama pi (FIXED di `c0e7f99`)
2. **Split ratio terbalik** — ukuran pane sub-agent tidak proporsional (new pane dapat 70% bukan 30%) (FIXED di `7750534`)
3. **Kegagalan silent/tersembunyi** — error handling yang menggunakan `catch {}` kosong menyembunyikan kegagalan, membuat debugging sangat sulit
4. **Race condition startup** — delay `getShellReadyDelayMs()` (default 500ms) bisa tidak cukup untuk shell startup di pane baru
5. **Dead code deteksi backend** — env var `PI_SUBAGENT_MUX` dibaca tapi tidak pernah digunakan dalam logika pemilihan backend

## Root Cause Analysis

### Timeline Perubahan Kritis

```
2026-06-25 00:03  e6e32d1  — Refactor ekstraksi DWM tile layout
2026-06-25 00:41  9dfe8b9  — Fix pane_not_found di layout
2026-06-26 22:52  c0e7f99  — Fix TMUX_PANE anchoring
2026-06-27 04:02  7750534  — Fix split ratio inverted
2026-06-27 04:08  9cfd238  — Fix DEFAULT_SPLIT_RATIO untuk tiling
2026-06-27 04:13  e50ca6f  — Fix herdr split ratio
```

### Masalah 1: Pane Spawning di Window Salah (FIXED — `c0e7f99`)

**Deskripsi:** Ketika user switch tmux window sementara pi sedang membangun context, `split-window` tanpa `-t` menargetkan **session's current window**, bukan window tempat pi berjalan. Akibatnya pane sub-agent muncul di window yang salah.

**Root cause:** Di `createSurfaceSplit()` untuk tmux, argumen `-t` hanya ditambahkan jika `fromSurface` disediakan. Setelah refactor `e6e32d1` (ekstraksi `createTileSurface`), nilai `fromSurface` untuk split pertama adalah `undefined` (sebelumnya selalu `TMUX_PANE`).

```typescript
// SEBELUM FIX (e6e32d1):
if (fromSurface) {
  args.push("-t", fromSurface);
}

// SESUDAH FIX (c0e7f99):
const target = fromSurface ?? process.env.TMUX_PANE;
if (target) {
  args.push("-t", target);
}
```

**Status:** ✅ Fixed

### Masalah 2: Split Ratio Terbalik untuk tmux (FIXED — `7750534`)

**Deskripsi:** Flag `-p` di tmux `split-window` menentukan ukuran **pane BARU** sebagai persentase dari available space. Kode sebelumnya menggunakan `(1-ratio)*100` yang berarti pane baru mendapat 70% bukan 30%.

```typescript
// SEBELUM FIX:
args.push("-p", String(Math.round((1 - ratio) * 100)));

// SESUDAH FIX:
args.push("-p", String(Math.round(ratio * 100)));
```

**Status:** ✅ Fixed

### Masalah 3: DEFAULT_SPLIT_RATIO Tidak Diterapkan ke Tiling Layout (FIXED — `9cfd238`)

**Deskripsi:** Layout `bottom-stack` menggunakan `DEFAULT_SPLIT_RATIO` di split pertama, tapi `tiling` layout tidak. Fix (`9cfd238`) mengubah `useFirstRatio` dari `layoutMode === "bottom-stack"` menjadi `true` untuk semua layout.

```typescript
// SEBELUM FIX (25be7df):
const useFirstRatio = layoutMode === "bottom-stack";

// SESUDAH FIX (9cfd238):
const useFirstRatio = true;
```

**Status:** ✅ Fixed

### Masalah 4: Dead Code — `muxPreference()` Tidak Pernah Dipanggil

**Deskripsi:** Fungsi `muxPreference()` di `mux.ts:44-48` membaca env var `PI_SUBAGENT_MUX` tapi **tidak pernah dipanggil** oleh `getMuxBackend()`. User tidak bisa override backend multiplexer via env var.

```typescript
function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "herdr" || pref === "tmux") return pref;
  return null;
}

export function getMuxBackend(): MuxBackend | null {
  if (isHerdrRuntimeAvailable()) return "herdr";
  if (isTmuxRuntimeAvailable()) return "tmux";
  return null;
  // muxPreference() NOT CALLED — dead code
}
```

**Status:** 🟡 Belum diperbaiki — dead code, bukan bug langsung

### Masalah 5: Race Condition Shell Startup di Pane Baru

**Deskripsi:** Setelah `createSurface` membuat pane baru, ada delay `getShellReadyDelayMs()` (default 500ms). Setelah delay, `sendLongCommand` mengirim command via `sendCommand`:

```typescript
// sendCommand untuk tmux:
execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
```

Dua `execFileSync` terpisah untuk literal text + Enter. Jika shell di pane baru belum siap (misal loading .bashrc/.zshrc yang berat, atau system lambat), keystrokes bisa hilang atau masuk ke prompt yang belum selesai.

**Faktor risiko:**
- System dengan I/O lambat (HDD, container startup)
- Konfigurasi shell yang berat (nvm, rvm, pyenv, dll)
- Tmux plugin yang memperlambat shell startup

**Status:** ❌ Belum diperbaiki — potensi race condition

### Masalah 6: Silent Error Swallowing

**Deskripsi:** Banyak operasi tmux yang menggunakan `catch {}` kosong, menyembunyikan error:

- `hasCommand()` di `mux.ts:23,27,35` — catch kosong
- `tmuxResizeStack()` di `tmux-mux.ts:14` — catch kosong
- `tmuxGetPaneHeight()` di `tmux-mux.ts:28` — catch return 0
- `renameSurface()` di `mux.ts:368,377` — catch kosong
- `createTileSurface()` di `mux-layout.ts:99` — catch generic

Ini membuat debugging sangat sulit karena error tmux tidak terlihat.

**Status:** ❌ Belum diperbaiki — menyulitkan debugging

## Commit-commit Relevan

| Hash | Tanggal | Pesan | Dampak |
|------|---------|-------|--------|
| `c0e7f99` | 2026-06-26 | fix(tmux): anchor split-window to TMUX_PANE | Critical — mencegah pane di window salah |
| `7750534` | 2026-06-27 | fix(tmux): correct inverted split ratio -p flag | Critical — memperbaiki ukuran pane |
| `9cfd238` | 2026-06-27 | fix(layout): apply DEFAULT_SPLIT_RATIO | Medium — konsistensi layout |
| `e6e32d1` | 2026-06-25 | refactor: extract DWM tile layout | Introduced regression (pane anchoring) |
| `25be7df` | 2026-06-26 | feat(layout): add bottom-stack layout | Medium — memperkenalkan split ratio |
| `e50ca6f` | 2026-06-27 | fix(herdr): correct inverted split ratio | Hanya herdr, bukan tmux |
| `9dfe8b9` | 2026-06-25 | fix(mux-layout): handle pane_not_found | Medium — pane closure handling |

## File-file yang Terlibat

| File | Peran | Baris Kritis |
|------|-------|-------------|
| `pi-extension/subagents/mux.ts` | Backend abstraction — semua operasi tmux/herdr | `getMuxBackend()`, `createSurfaceSplit()`, `sendCommand()`, `pollForExit()` |
| `pi-extension/subagents/tmux-mux.ts` | Fungsi resize spesifik tmux | Semua fungsi — banyak `catch {}` silent |
| `pi-extension/subagents/mux-layout.ts` | Layout engine — DWM tiling + bottom-stack | `createTileSurface()`, `DEFAULT_SPLIT_RATIO` |
| `pi-extension/subagents/spawner.ts` | Lifecycle launch + watch | `launchSubagent()`, `sendLongCommand()` |
| `pi-extension/subagents/subagent.ts` | Tool handler subagent | `executeSubagentTool()` — panggil `isMuxAvailable()` |
| `pi-extension/subagents/agent.ts` | Agent defaults, path resolution | `getShellReadyDelayMs()`, `muxUnavailableResult()` |
| `test/mux-layout.test.ts` | Unit test layout | Mock — tidak tes tmux asli |

## Rekomendasi Perbaikan

### Prioritas Tinggi

1. **Tambahkan logging/debug mode untuk tmux operations**
   - Di `sendCommand`, `createSurfaceSplit`, `sendLongCommand`: log command tmux yang dijalankan dan output-nya
   - Bisa menggunakan env var `PI_SUBAGENT_DEBUG=1` untuk mengaktifkan
   - File: `pi-extension/subagents/mux.ts`

2. **Perbaiki shell startup race condition**
   - Ganti delay fixed 500ms dengan polling: `tmux display-message -p -t <surface> "#{pane_height}"` sampai return value > 0
   - Atau gunakan `-d` flag di `send-keys` untuk menunggu pane siap
   - File: `pi-extension/subagents/spawner.ts`, `mux.ts`

3. **Integrasikan `muxPreference()` ke `getMuxBackend()`**
   - `PI_SUBAGENT_MUX` env var harus diprioritaskan sebelum auto-detection
   - File: `pi-extension/subagents/mux.ts`

### Prioritas Medium

4. **Kurangi silent error swallowing**
   - Di `renameSurface()` dan operasi tmux lainnya: log error ke stderr atau debug channel
   - File: `pi-extension/subagents/mux.ts`, `tmux-mux.ts`

5. **Tambahkan tmux integration test**
   - Test dengan tmux asli (bukan mock) untuk memverifikasi `split-window`, `send-keys`, `capture-pane`
   - Bisa menggunakan `tmux new-session -d -x 200 -y 100` di CI
   - File: baru `test/tmux-integration.test.ts`

6. **Verifikasi kompatibilitas versi tmux**
   - Test dengan tmux 3.2, 3.3, 3.4, 3.5 (perilaku `-p` flag bisa berbeda antar versi)
   - Dokumentasikan versi minimum tmux yang didukung

### Prioritas Rendah

7. **Refactor `sendCommand` untuk tmux jadi satu panggilan**
   - Gunakan `tmux send-keys -t <surface> -l "<command>\n"` — satu panggilan dengan newline embedded
   - Atau gunakan `tmux send-keys -t <surface> <command> Enter` (tanpa `-l`) — ini juga lebih reliable
   - File: `pi-extension/subagents/mux.ts`

## Analisis Flow Sub-agent di Tmux

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MAIN PROCESS (pi)                           │
│                                                                     │
│  1. executeSubagentTool()                                           │
│     └─ isMuxAvailable() ✓ (TMUX env var + tmux binary)             │
│     └─ launchSubagent()                                            │
│        └─ createSurface(name)                                       │
│           └─ createTileSurface(name, "tmux", createSurfaceSplit)    │
│              └─ createSurfaceSplit("right", undefined, 0.30)        │
│                 └─ tmux split-window -d -h -p 30 -t %0 -P -F "#{pane_id}" │
│                    └─ returns "%12"                                 │
│        └─ renameSurface("%12", "agent: name")                      │
│           └─ tmux select-pane -t %12 -T "agent: name"              │
│        └─ delay (500ms default) ⚠️ RACE CONDITION                  │
│        └─ sendLongCommand("%12", command)                          │
│           └─ writes script.sh dengan #!/bin/bash + command          │
│           └─ sendCommand("%12", "bash /path/to/script.sh")          │
│              └─ tmux send-keys -t %12 -l "bash /path/to/script.sh"  │
│              └─ tmux send-keys -t %12 Enter                         │
│                                                                     │
│  2. watchSubagent() (async)                                         │
│     └─ pollForExit()                                                │
│        └─ fast path: check .exit sidecar file                       │
│        └─ slow path: tmux capture-pane -p -t %12 -S -5             │
│           └─ cari "__SUBAGENT_DONE_<code>__"                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         SUBAGENT PANE (%12)                         │
│                                                                     │
│  $ bash /path/to/script.sh  ← diterima dari send-keys              │
│    └─ Script: #!/bin/bash                                          │
│       └─ pi --session <file> -e <ext> --model <m> @/task.md        │
│          └─ berjalan sebagai sub-agent pi session                   │
│       └─ echo '__SUBAGENT_DONE_0__'                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Kesimpulan

Dari analisis git history dan kode, **dua bug kritis yang menyebabkan sub-agent gagal berjalan di tmux sudah diperbaiki**: pane spawning di window salah (`c0e7f99`) dan split ratio inverted (`7750534`). Namun masih ada **beberapa celah yang bisa menyebabkan kegagalan intermiten**:

1. **Race condition shell startup** — delay 500ms tidak menjamin shell siap menerima input
2. **Silent error handling** — error tmux disembunyikan, menyulitkan diagnosis
3. **Dead code `muxPreference()`** — env var overrides tidak berfungsi

Jika sub-agent masih gagal berjalan di environment tmux saat ini, kemungkinan besar penyebabnya adalah **race condition startup** atau **error tersembunyi di `sendCommand`/`createSurfaceSplit`** yang tertelan oleh `catch {}` kosong.

Rekomendasi segera: aktifkan debug logging dengan menambahkan `console.error` di sekitar operasi tmux untuk menangkap error yang sebenarnya terjadi.
