# Laporan: Investigasi Gagal Spawn Sub-Agent di Tmux vs Berhasil di Herdr

## Ringkasan

Sub-agent berhasil _spawn_ di environment herdr tapi gagal di tmux. Laporan ini membandingkan secara detail perbedaan flow eksekusi antara kedua backend multiplexer dan mengidentifikasi root cause potensial.

---

## 1. Perbedaan Fundamental Arsitektur

### 1.1 Command Execution

| Aspek | herdr | tmux |
|-------|-------|------|
| **Mekanisme** | `herdr pane run <surface> <command>` — daemon langsung mengeksekusi command di pane | `tmux send-keys -t <surface> -l <command>` + `send-keys Enter` — mengetik karakter demi karakter |
| **Medium** | Protokol daemon (socket/pipe) | Terminal emulation (PTY input) |
| **Ketergantungan Shell** | Rendah — daemon menangani eksekusi langsung | Tinggi — tergantung shell pane menerima input dengan benar |
| **Output capture** | `herdr pane read --source recent` — buffer bersih tanpa ANSI | `tmux capture-pane -p -t <surface> -S -N` — visible screen content |

**Implikasi**: Tmux mengandalkan simulasi keyboard. Setiap karakter diketik literal ke terminal pane. Ini rawan terhadap:
- Terminal width wrapping
- Shell yang belum siap
- Input buffering race condition
- Interferensi mouse mode

### 1.2 Output Reading untuk Sentinel Detection

Di `pollForExit()` (mux.ts:505):
```typescript
const screen = await readScreenAsync(surface, 5);
const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
```

| Aspek | herdr | tmux |
|-------|-------|------|
| **Command** | `herdr pane read --source recent --lines 5` | `tmux capture-pane -p -t <surface> -S -5` |
| **Source** | Internal daemon buffer (recent output) | Visible terminal screen |
| **ANSI filtering** | Otomatis (buffer bersih) | Manual — output mentah termasuk escape codes |
| **Scrollback** | Termasuk dalam "recent" | Hanya visible screen — tidak termasuk scrollback |

**CRITICAL**: `tmux capture-pane -S -5` hanya menangkap 5 baris terakhir dari LAYAR YANG TERLIHAT. Jika output sub-agent lebih panjang dari tinggi pane, sentinel bisa ter-*scroll* dan tidak terdeteksi. Ini adalah **race condition yang sangat real** — semakin lama sub-agent berjalan, semakin banyak output, semakin besar kemungkinan sentinel hilang.

---

## 2. Perbedaan Detail per Fungsi

### 2.1 Pane Creation (`createSurfaceSplit`)

**herdr** (mux.ts):
```typescript
const result = execFileSync("herdr", ["pane", "split", targetPane, "--direction", dir, "--no-focus"]);
const parsed = JSON.parse(result);
const paneId = parsed?.result?.pane?.pane_id;
```
- Output terstruktur (JSON)
- Validasi hanya `if (!paneId)` → error jelas

**tmux** (mux.ts):
```typescript
const args = ["split-window", "-d"];
args.push("-P", "-F", "#{pane_id}");
const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
}
```
- Output plain text, parsing minimal
- **Validasi ketat**: `if (!pane.startsWith("%"))` — jika tmux mengeluarkan warning/error apapun, split dianggap gagal
- Tidak ada `--no-focus` analog — tmux `-d` sudah create detached

### 2.2 Command Delivery (`sendLongCommand`)

**Keduanya** menulis script `.sh` dulu, lalu menjalankannya:

**Script yang ditulis:**
```bash
#!/bin/bash
# Subagent launch script for Scout
# Generated: ...
# Session: ...
# Surface: ...

cd /path && PI_CODING_AGENT_DIR=/path PI_SUBAGENT_NAME=Scout ... pi --session ... -e ... --tools ... @task.md ; echo '__SUBAGENT_DONE_'$?'__'
```

**herdr:**
```typescript
execFileSync("herdr", ["pane", "run", surface, "bash " + shellEscape(scriptPath)]);
```
- Daemon langsung mengeksekusi `bash <scriptPath>` di pane
- Tidak ada karakter yang diketik — langsung run

**tmux:**
```typescript
sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
// → tmux send-keys -t <surface> -l "bash '/tmp/.../cmd-xxx.sh'"
// → tmux send-keys -t <surface> Enter
```
- **KARAKTER DIKETIK SATU PER SATU** ke terminal
- `send-keys -l` mengirim literal characters
- Lalu Enter ditekan
- **Rentan terhadap**: terminal wrapping, shell prompt belum muncul, race condition input

### 2.3 Sentinel Detection (`pollForExit`)

```typescript
// Fast path: .exit file (dari subagent_done / caller_ping)
if (options.sessionFile) { ... }

// Slow path: terminal screen
const screen = await readScreenAsync(surface, 5);
const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
```

**Untuk tmux, ada 2 failure mode sentinel:**

1. **Screen terlalu penuh**: Output sub-agent melebihi 5 baris dari posisi kursor terakhir. `capture-pane -S -5` hanya menangkap 5 baris. Jika kursor sekarang di baris 24 dari 24 (visible screen height), dan sentinel ada di baris 19 (sudah 6 baris ke belakang), terlewat.

2. **ANSI escape codes mengganggu regex**: Jika output pi mengandung karakter kontrol yang tercampur dengan sentinel, regex `__SUBAGENT_DONE_(\d+)__` mungkin tidak match karena ada karakter tak terlihat di antaranya.

### 2.4 Pane Cleanup

**herdr:** `herdr pane close <surface>` — graceful close via daemon
**tmux:** `tmux kill-pane -t <surface>` — SIGTERM paksa ke proses pane

`kill-pane` bisa membunuh proses script sebelum sentinel sempat di-*echo*. Tapi ini hanya terjadi saat cleanup setelah deteksi, jadi tidak menyebabkan kegagalan deteksi.

---

## 3. Temuan Kritis: Fungsi `isFishShell()` Tidak Dipakai

**File**: `mux.ts:84-93`

```typescript
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}
```

**Kedua fungsi ini DIDEFINISIKAN tapi TIDAK PERNAH DIPANGGIL** di seluruh codebase.

Sentinel hardcoded sebagai `$?` di dua tempat:
- `spawner.ts:200`: `` const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`; ``
- `subagent.ts:220`: `` const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`; ``

**Dampak**: Jika user menggunakan fish shell, sentinel `$?` akan selalu `0` (bukan exit code sebenarnya), dan di beberapa versi fish malah error. Tapi untuk user ini (bash), tidak relevan.

---

## 4. Environment Variable Propagation

### 4.1 tmux update-environment

Tmux user memiliki konfigurasi `update-environment` DAFTAR VARIABEL TERTENTU yang disync dari client ke server:

```
update-environment[0] DISPLAY
update-environment[1] KRB5CCNAME
...
update-environment[9] TERM
update-environment[10] TERM_PROGRAM
```

**Yang TIDAK ADA di update-environment:**
- `PATH ❌`
- `BUN_INSTALL ❌`
- `PI_CODING_AGENT_DIR ❌`
- `NODE_PATH ❌`

**Dampak**: Jika tmux server start dari environment yang berbeda dengan environment saat `pi` jalan, PATH di pane baru mungkin tidak mengandung `~/.bun/bin` (tempat `pi` binary).

### 4.2 Bagaimana env vars dikirim ke sub-agent

Di `spawner.ts`, env vars dikirim sebagai PREFIX command:

```typescript
const envPrefix = envParts.join(" ") + " ";
```

```bash
PI_CODING_AGENT_DIR=/path PI_SUBAGENT_NAME=Scout ... pi --session ...
```

Ini adalah **bash syntax** — env vars set sebagai prefix command. Bekerja di bash/zsh, TAPI tidak bekerja di fish shell (fish menggunakan `env VAR=VAL command`).

### 4.3 `PI_CODING_AGENT_DIR` Fallback

```typescript
if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
} else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
}
```

Jika keduanya tidak ada, `PI_CODING_AGENT_DIR` tidak diset. Di environment user saat ini (`HERDR_ENV=1`), `PI_CODING_AGENT_DIR` juga tidak diset. Ini berarti sub-agent akan menggunakan default `~/.pi/agent/` — yang seharusnya sama.

---

## 5. Konfigurasi Tmux yang Bisa Menginterferensi

### 5.1 `set -g mouse on` ⚠️

Mouse mode ON di tmux. Walaupun `send-keys` seharusnya bypass mouse processing, ada edge cases:
- Beberapa aplikasi di pane mengaktifkan SGR mouse mode
- Event mouse bisa mengubah state terminal
- **Potensi**: Jika shell pane mengaktifkan bracketed paste mode atau application keypad mode, `send-keys` bisa berperilaku berbeda

### 5.2 Shell Init Race Condition

`getShellReadyDelayMs()` = **500ms** default.

Di spawner.ts:
```typescript
if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
}
```

Untuk **herdr**: `herdr pane run` dikirim via daemon — daemon menjamin shell sudah ready. Delay 500ms adalah safety margin.

Untuk **tmux**: `send-keys` mengetik literal ke terminal. Jika shell pane belum selesai init dalam 500ms:
- Karakter perintah bisa tercampur dengan prompt
- Atau masuk ke input buffer dan dieksekusi saat shell siap — OK, sebenarnya ini masih bekerja karena input buffer terminal
- TAPI: jika ada output init shell yang sangat panjang (complex PS1, fetch, dll), prompt belum muncul dan perintah bisa berada di tengah-tengah output init

Tmux 3.6b dengan bash seharusnya init dalam <100ms, tapi konfigurasi bashrc yang kompleks bisa memperlambat.

### 5.3 `allow-rename off` dan `set -g status off` (tidak diset)

`allow-rename off` mencegah aplikasi mengubah window title. Ini tidak masalah untuk subagent.

`set -g status` tidak dimatikan — status bar tetap aktif. Ini mengurangi 1 baris dari tinggi pane yang available. Tidak signifikan.

---

## 6. Analisis Root Cause

### Root Cause A (Paling Mungkin): Sentinel Tidak Terdeteksi

**Mekanisme**: `pollForExit` hanya membaca 5 baris terakhir visible screen (`readScreenAsync(surface, 5)`). Jika output sub-agent melebihi (pane_height - 5) baris, sentinel di baris paling akhir sudah bukan di 5 baris terakhir visible area.

**Mengapa herdr OK**: `herdr pane read --source recent --lines 5` membaca dari daemon buffer, bukan visible screen. Daemon buffer menyimpan semua output recent, termasuk yang sudah scroll.

**Mengapa tmux GAGAL**: `tmux capture-pane -p -S -5` hanya membaca visible screen. Output yang sudah scroll (tapi masih di scrollback history) tidak terbaca.

**Kondisi**: 
- Tinggi pane: ~20 baris (default split)
- Output sub-agent tool calls + responses: ~30-50 baris
- Sentinel di baris ke-30+ → sudah scroll lewat visible screen
- `capture-pane -S -5` membaca baris 16-20 (visible area bawah)
- Sentinel di baris 30 → tidak ketemu → polling forever → timeout/abort

**Probabilitas**: TINGGI — ini jelas perbedaan fundamental antara herdr dan tmux dalam cara membaca output.

### Root Cause B: Send-Keys vs Pane Run

**Mekanisme**: tmux `send-keys` mengetik karakter. Jika ada timing issue atau shell state issue, command bisa tidak tereksekusi dengan benar.

**Mengapa herdr OK**: `herdr pane run` tidak tergantung shell state — daemon langsung run.

**Mengapa tmux GAGAL**: Ada beberapa failure mode:
1. Command terkikirim tapi shell belum ready → karakter masuk buffer, dieksekusi saat shell siap, tapi mungkin ada karakter yang hilang
2. Command terkikirim di tengah output shell init → tercampur
3. Terminal width wrapping → command terpotong baris

### Root Cause C: tmux pane_id Format Validation

Di `createSurfaceSplit`, tmux mengecek `if (!pane.startsWith("%"))`. Jika tmux outputnya mengandung error (misalnya "can't find pane %xx" karena pane sudah closed dari session sebelumnya), split akan throw error tanpa retry.

### Root Cause D: PATH tidak mengandung `~/.bun/bin` di tmux pane baru

Jika tmux server start dari cron/systemd (PATH minimal), `pi` binary tidak ditemukan di pane baru. Meskipun .bashrc menambahkan PATH, ada gap waktu 500ms di mana PATH belum mengandung bun path. Tapi dengan `send-keys`, shell sudah fully initialized dan PATH sudah benar.

---

## 7. Hipotesis Spesifik

### H1: Poll loop membaca visible screen, bukan scrollback
→ Tmux `capture-pane -S -5` vs herdr `pane read --source recent`
→ Output sub-agent menumpuk, sentinel di luar 5 baris visible screen
→ pollForExit looping forever
→ **Paling mungkin karena ini perbedaan fundamental**

### H2: Shell tidak ready saat send-keys tiba
→ 500ms default delay tidak cukup di beberapa kondisi
→ Lebih jarang karena bash init cepat
→ **Mungkin terjadi di mesin lambat atau dengan .bashrc kompleks**

### H3: Mouse mode menganggu input processing
→ `set -g mouse on` bisa mengubah cara tmux memproses input
→ **Kurang mungkin — send-keys bypass mouse processing**

### H4: Sentinel `$?` salah karena fish shell
→ Tapi user pakai bash, jadi tidak relevan
→ **Tidak relevan untuk user ini**

---

## 8. Rekomendasi Perbaikan

### Prioritas 1: Fix Sentinel Detection (Root Cause A)

**Masalah**: `pollForExit` membaca hanya 5 baris visible screen untuk tmux.

**Solusi**: 
1. **Gunakan `-S -` (entire scrollback)** di tmux `capture-pane`, atau setidaknya `-S -200` untuk mencakup lebih banyak history
2. Atau gunakan `-a` flag untuk include scrollback: `tmux capture-pane -p -t <surface> -a -S -5` (alternatif)
3. Di `pollForExit`, tingkatkan dari 5 ke 100+ lines untuk safety margin

```typescript
// Di mux.ts readScreenAsync untuk tmux:
// Ganti -S -5 dengan -S -200 atau -S - (full history)
// Ini memastikan sentinel tetap terbaca meskipun sudah scroll
```

### Prioritas 2: Gunakan Active Shell Readiness Check

**Masalah**: Delay 500ms statis untuk shell pane ready.

**Solusi**: Ganti delay statis dengan active check:
```typescript
// Tunggu sampai prompt muncul di pane
await waitForPrompt(surface);
```

Implementasi: baca screen pane secara periodik sampai prompt pattern terlihat.

### Prioritas 3: Eksplisit Set PATH di Send-Long-Command

**Masalah**: PATH mungkin berbeda di tmux pane baru.

**Solusi**: Tambahkan `export PATH=$PATH` atau sertakan `bun/bin` path secara eksplisit di script preamble:

```typescript
scriptPreamble: [
  `# Subagent launch script...`,
  `export PATH="${process.env.PATH ?? '/usr/bin:/bin'}"`,
  ...
]
```

### Prioritas 4: Gunakan `isFishShell()` / `exitStatusVar()` yang Sudah Ada

**Masalah**: Fungsi sudah ada tapi tidak dipakai.

**Solusi**: Ganti hardcoded `$?` dengan panggilan `exitStatusVar()`:

```typescript
// Di spawner.ts:
const evar = exitStatusVar();
const command = `${piCommand}; echo '__SUBAGENT_DONE_'\$\{evar}'__'`;
```

Atau lebih baik: selalu jalankan script via `bash` (sudah dilakukan via `sendLongCommand`), jadi `$?` selalu aman.

### Prioritas 5: Fallback Sentinel via .exit File (Sudah Ada)

Fast path `.exit` file sudah diimplementasikan. Ini adalah mekanisme yang lebih reliable. Pastikan selalu ada `.exit` file yang ditulis sebagai fallback, tidak hanya mengandalkan sentinel terminal.

---

## 9. Kesimpulan

**Root cause paling mungkin**: `tmux capture-pane` di `pollForExit` hanya membaca 5 baris visible screen, sementara `herdr pane read` membaca dari buffer daemon yang menyimpan semua output recent. Ketika sub-agent menghasilkan output yang lebih panjang dari visible pane area, sentinel `__SUBAGENT_DONE_N__` tidak terdeteksi oleh tmux backend, menyebabkan polling loop berjalan selamanya.

**Kedua**: tmux `send-keys` mengetik karakter literal, sementara herdr `pane run` mengeksekusi langsung via daemon. Ini membuat tmux rentan terhadap race condition shell readiness, terminal wrapping, dan interferensi input.

**Ketiga**: Environment PATH tidak dijamin sama antara parent pane dan pane baru di tmux, tergantung konfigurasi `update-environment`.

**Perbaikan prioritas**: Fix tmux `capture-pane` untuk membaca dari scrollback (bukan hanya visible screen), dan tingkatkan line count untuk sentinel detection.
