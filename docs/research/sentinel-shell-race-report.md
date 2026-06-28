# Laporan Riset: Sentinel 5-line Limit & Shell Readiness Race

**Tanggal:** 2026-06-28
**Lokasi kode sumber:** `pi-extension/subagents/mux.ts`, `spawner.ts`, `agent.ts`

---

## 1. Sentinel 5-line Limit

### 1.1. Apa itu Sentinel-Based Exit Detection?

Sentinel-based exit detection adalah pola di mana sebuah **marker unik** (sentinels) ditempelkan pada akhir command yang dikirim ke terminal multiplexer. Ketika command selesai, sentinelakan muncul di output terminal dan bisa dideteksi dengan polling/capture.

**Contoh mekanisme (dari `spawner.ts`):**
```typescript
const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
```
Setelah command selesai, terminal akan mencetak `__SUBAGENT_DONE_0__` (atau exit code lain) sebagai baris terakhir.

**Pendekatan serupa di industri:**
- **mac-mini-agent / drive CLI** (disler) — menggunakan `__START_<token>` dan `__DONE_<token>:<exit_code>` sebagai paired markers. Ini memungkinkan ekstraksi output di antara kedua marker, sehingga immune terhadap terminal line wrapping.
  - Sumber: https://github.com/disler/mac-mini-agent/blob/main/apps/drive/modules/sentinel.py
  - Dokumentasi: https://deepwiki.com/disler/mac-mini-agent/4.3-sentinel-protocol

### 1.2. Mengapa Membaca Hanya 5 Baris Terakhir Bermasalah?

Di `mux.ts`, fungsi `pollForExit()`:

```typescript
// Slow path: read terminal screen for sentinel (crash detection)
try {
  const screen = await readScreenAsync(surface, 5);
  const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
  ...
```

Parameter `5` diteruskan ke `readScreenAsync()` yang menggunakan:
- **herdr:** `herdr pane read <pane> --source recent --lines 5`
- **tmux:** `tmux capture-pane -p -t <pane> -S -5`

**Masalah:** Jika output sub-agent menghasilkan lebih dari 5 baris (termasuk blank lines), sentinel `__SUBAGENT_DONE_$?__` akan **scroll off** dari buffer yang di-capture. Polling berikutnya tidak akan pernah menemukan sentinel, mengakibatkan timeout.

### 1.3. Kapan Output Bisa Melebihi 5 Baris?

1. **Sub-agent task yang verbose** — command `ls -la`, `npm install`, `git log`, dll bisa menghasilkan puluhan hingga ribuan baris.
2. **Error stack trace** — runtime error bisa mencetak stack trace panjang.
3. **Multi-line task file** — task yang disampaikan via artifact (`@<path>`) dibaca dan diproses oleh pi, dan output prompt/file bisa sangat panjang.
4. **Tool execution output** — setiap tool call (read, write, bash) mencetak hasilnya ke terminal.
5. **Startup banner dan spinner** — pi CLI mencetak status messages yang mendorong sentinel keluar dari 5-line window.
6. **Session file seeding** — `seedSubagentSessionFile()` bisa mencetak context ke terminal sebelum command utama jalan.

### 1.4. Alternatif Pendekatan

| Pendekatan | Kelebihan | Kekurangan |
|---|---|---|
| **Baca lebih banyak lines** (misal 100-500) | Sederhana, perubahan kecil | Masih rawan overflow jika output massive, lebih lambat |
| **Baca entire scrollback** (`-S -` di tmux) | Tidak ada batas line | Lambat untuk pane dengan buffer besar |
| **Grep via backend** (tmux capture-pane + grep) | Lebih efisien daripada baca semua | Masih polling-based |
| **File-based sidecar** ✅ | **Sudah diimplementasi** — `.exit` file ditulis oleh `subagent_done.ts`. Ini adalah **fast path** yang langsung return tanpa perlu baca terminal | Bergantung pada sub-agent bisa menulis file sebelum exit |
| **tmux `pipe-pane`** | Output langsung dialirkan ke file/command — event-driven, tanpa polling | Overhead pipe, perlu cleanup |
| **herdr `wait output --match`** | Blocking wait native — event-driven, efisien | Hanya untuk herdr backend |
| **`window-status-format` + hooks** tmux | Bisa trigger event saat pane selesai | Kompleks, perlu konfigurasi tmux |

### 1.5. Bagaimana herdr Handle Exit Detection?

Herdr menyediakan **`herdr wait output <pane_id> --match <text>`** yang merupakan blocking wait native — ia menunggu sampai pattern tertentu muncul di output pane, tanpa polling loop. Opsi:
- `--source visible|recent|recent-unwrapped` — dari mana membaca
- `--lines N` — berapa banyak baris yang di-scan
- `--timeout MS` — timeout
- `--regex` — pattern matching via regex
- `--raw` — output mentah

Herdr juga punya **`herdr wait agent-status <pane_id> --status <state>`** untuk menunggu state agent tertentu (idle, working, blocked, done, unknown).

Ini adalah **event-driven replacement** untuk `pollForExit()` — tidak perlu polling loop di aplikasi, backend herdr sendiri yang blocking sampai pattern terdeteksi.

Sumber: https://herdr.dev/docs/cli-reference/

### 1.6. Bagaimana tmux Handle Exit Detection?

tmux tidak memiliki built-in "wait for output pattern" seperti herdr. Tapi ada beberapa mekanisme:

- **`wait-for -L` / `wait-for -U`** — channel-based signaling. Satu pane bisa lock channel, pane lain bisa menunggu unlock. Tapi ini manual — harus explicit `tmux wait-for -S signalname` di command.
  - Sumber: https://unix.stackexchange.com/questions/137426/make-tmux-block-until-program-completes
- **`pipe-pane`** — mengalirkan output ke file atau command. Bisa digunakan untuk log-based detection.
  - Sumber: https://tmuxai.dev/docs/guides/pipe-pane-output
- **`capture-pane`** — polling-based, inilah yang digunakan codebase saat ini.

### 1.7. Best Practice Sentinel Saat Ini (di Codebase)

Codebase sudah punya **dual-path approach** yang baik:
1. **Fast path** — `.exit` sidecar file, ditulis oleh `subagent_done.ts`. Langsung return tanpa baca terminal.
2. **Slow path** — sentinel `__SUBAGENT_DONE_$?__` di terminal, sebagai **crash detection fallback** ketika sub-agent mati tanpa sempat nulis sidecar.

Masalah slow path: limit 5 lines terlalu agresif. Ketika `.exit` file tidak terdeteksi (crash, kill -9, OOM), fallback ke sentinel di terminal sangat mungkin gagal karena output sudah terlanjur overflow.

---

## 2. Shell Readiness Race Condition

### 2.1. Apa Itu Shell Readiness Race Condition?

Race condition di mana command dikirim ke pane terminal **sebelum shell di pane tersebut selesai initialisasi**. Di codebase, ini terjadi di `spawner.ts`:

```typescript
const surface = options?.surface ?? createSurface(params.name);
// ... rename surface ...

if (!surfacePreCreated) {
  await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
}
```

Default delay: **500ms** (`PI_SUBAGENT_SHELL_READY_DELAY_MS`).

Masalah: ketika shell belum siap menerima input, karakter yang dikirim bisa:
- Hilang (tidak diproses)
- Masuk ke buffer shell yang belum siap dan menjadi corrupt
- Ditampilkan tapi tidak dieksekusi
- Menggabung dengan prompt parsial

### 2.2. Kenapa Fixed Delay Tidak Reliable?

1. **Variasi kecepatan shell startup:**
   - Shell minimal (bash dasar): ~50-100ms
   - zsh + oh-my-zsh + plugin: **~2.4 detik** (sumber: Claude Code issue #40168)
   - zsh + nvm, mise, pyenv, starship, direnv: 1-3+ detik
   - Fish shell dengan plugin: variatif
   
2. **Beban sistem:**
   - CPU throttling akibat beban tinggi
   - I/O wait (disk, network)
   - Container startup (Docker, devcontainer)

3. **Tidak bisa di-tuning secara adaptif:**
   - 500ms terlalu pendek untuk heavy shell config
   - Tapi terlalu panjang untuk shell minimal (membuang waktu)

4. **Race tetap terjadi meski shell cepat:**
   - Issue #40168 melaporkan: bahkan setelah mengoptimalkan `.zshrc` ke ~0.03s, race masih terjadi
   - Ini mengindikasikan masalah **timing dispatch** di tmux/herdr — send-keys mungkin dikirim sebelum shell siap terlepas dari kecepatan shell

**Sumber:**
- https://github.com/anthropics/claude-code/issues/23513 — "Team agents fail to start: tmux send-keys race condition with shell initialization"
- https://github.com/anthropics/claude-code/issues/37217 — "Agent team: command sent to new pane before shell is ready"
- https://github.com/anthropics/claude-code/issues/40168 — "command sent via send-keys before shell is ready, teammates fail to start"
- https://github.com/anthropics/claude-code/issues/33987 — "Add configurable delay for tmux send-keys when spawning team agents"

### 2.3. Prompt Detection Sebagai Alternatif

Prompt detection adalah teknik membaca output pane untuk mencari **prompt shell** (karakter seperti `$`, `%`, `#`, atau custom PS1). Begitu prompt terdeteksi, shell sudah siap menerima command.

**Cara kerja:**
1. Buat pane
2. Polling `capture-pane` sampai baris terakhir adalah prompt (atau mengandung karakter prompt)
3. Kirim command

**Kelemahan:**
- **PS1 bisa sangat bervariasi** — Starship, Powerlevel10k, custom prompt, multi-line prompt
- **Prompt bisa mirip dengan output program** — misal shell `$` juga muncul di output `grep`
- **Shell yang sudah tidak response** (stuck) tetap menunjukkan prompt
- **Butuh knowledge tentang shell user** — tidak portable

### 2.4. Tools/Mekanisme untuk Deteksi Shell Ready

| Mekanisme | Cara Kerja | Kelebihan | Kekurangan |
|---|---|---|---|
| **Fixed delay (`sleep`)** | Tunggu X ms sebelum kirim command | Sederhana | Tidak reliable, waste waktu |
| **Marker polling (`echo __READY__`)** | Kirim sentinel echo, tunggu outputnya | Reliable, cepat, shell-agnostic | Overhead satu command tambahan, butuh cleanup |
| **Prompt detection** | Cari $/%/# di output | Tidak perlu command tambahan | Tidak reliable, PS1 bervariasi |
| **Cursor position polling** (tmuxp) | Poll cursor position dari (0,0) | Deteksi shell ready tanpa command tambahan | Cursor bisa kembali ke (0,0) untuk alasan lain |
| **`tmux split-window "command"`** | Langsung run command di window baru, tanpa send-keys | Tidak ada race — shell tidak terlibat untuk argument parsing | Tidak bisa kirim command interaktif, escape complex |
| **`herdr wait output --match`** | Blocking wait untuk pattern tertentu | Event-driven, efisien, built-in | Hanya herdr |
| **expect script** | Tool khusus untuk automasi interactive CLI | Sangat matang, pattern-based | Overhead, tidak cocok untuk multiplexer |
| **tmux wait-for channel** | Signaling antar pane via channel | Native tmux, ringan | Manual setup, butuh sinkronisasi |

#### Detail: Shell Readiness Polling (Marker-based)

Pendekatan yang direkomendasikan di Claude Code issues:

```
# 1. Kirim marker command
tmux send-keys -t <pane> 'echo __SUBAGENT_READY__'
tmux send-keys -t <pane> Enter

# 2. Polling sampai marker terdeteksi di output
while ! tmux capture-pane -p -t <pane> -S -5 | grep -q '__SUBAGENT_READY__'; do
  sleep 0.1
done

# 3. Kirim command sebenarnya
tmux send-keys -t <pane> '<actual command>'
tmux send-keys -t <pane> Enter
```

Ini memastikan shell sudah siap karena shell telah berhasil mengeksekusi echo.

#### Detail: Cursor Position Polling (tmuxp)

tmuxp menggunakan pendekatan polling cursor position:

```python
# Polls the pane's cursor position until it moves from origin (0, 0),
# indicating the shell has finished initializing and drawn its prompt.
```

Sumber: https://tmuxp.git-pull.com/api/workspace/builder/

#### Detail: expect

`expect` adalah tool Tcl untuk automasi interactive program. Bekerja dengan pola:
```
expect "password:"   # tunggu pattern
send "mypassword\r"  # kirim response
```

Tidak cocok langsung untuk terminal multiplexer, tapi pola `expect/send` adalah inspirasi untuk prompt detection.

Sumber: https://man7.org/linux/man-pages/man1/expect.1.html

### 2.5. Best Practice di Terminal Multiplexer Programming

Berdasarkan riset dari berbagai proyek (Claude Code, herdr, tmuxp, mac-mini-agent, crux):

#### **Untuk Shell Readiness:**

1. **Gunakan marker polling (`echo __READY__`) — bukan fixed delay**
   - Ini adalah pendekatan paling reliable dan shell-agnostic
   - Gunakan unique token untuk menghindari false positive dari output sebelumnya
   - Timeout jika tidak terdeteksi dalam waktu tertentu

2. **Jika menggunakan herdr backend, gunakan `herdr wait output --match`**
   - Event-driven, tidak perlu polling loop
   - Backend yang handle blocking wait

3. **Jika hanya tmux yang tersedia, prioritaskan sequence:**
   ```
   tmux split-window ...            # buat pane
   tmux send-keys 'echo __READY__'  # kirim readiness marker
   # polling capture-pane untuk __READY__
   tmux send-keys '<real command>'  # baru kirim command real
   ```

4. **Hindari `tmux split-window "command"` langsung** — meski tidak ada race, ini membatasi fleksibilitas (tidak bisa kirim command bertahap, tidak bisa interactive).

#### **Untuk Sentinel/Exit Detection:**

1. **Prioritaskan file-based sidecar** — seperti `.exit` file yang sudah diimplementasi. Ini adalah **best practice** karena tidak bergantung pada buffer terminal.
   
2. **Fallback ke sentinel terminal dengan buffer yang cukup** — jika sidecar tidak tersedia (crash), baca minimal 100-500 lines terakhir, bukan hanya 5.

3. **Gunakan paired markers** (START/DONE) seperti mac-mini-agent — ini memungkinkan:
   - Deteksi completion yang deterministic
   - Exit code capture yang akurat
   - Output extraction yang immune terhadap line wrapping

4. **Untuk herdr, `herdr wait output --match`** adalah cara paling idiomatic.

### 2.6. Rekomendasi untuk Codebase

Berdasarkan analisis:

1. **Shell readiness:** Ganti fixed 500ms delay dengan **shell readiness polling** — kirim `echo __SUBAGENT_READY__` dan tunggu sampai terdeteksi di output pane sebelum mengirim command sebenarnya.

2. **Sentinel 5-line limit:** Naikkan limit ke angka yang lebih aman (100-500 lines), atau idealnya baca **entire scrollback** pada slow path. Tapi karena slow path adalah fallback untuk crash, mungkin lebih baik menggunakan **file-based approach saja** dengan timeout yang reasonable.

3. **Manfaatkan herdr native wait** — ketika backend adalah herdr, gunakan `herdr wait output --match __SUBAGENT_DONE_` daripada polling loop sendiri. Ini lebih efisien dan event-driven.

4. **Dual-track polling** — pertahankan fast path (.exit sidecar) sebagai primary, dan tingkatkan slow path (sentinel terminal) untuk jadi reliable fallback dengan buffer lebih besar.

---

## Sumber Referensi

### Sentinel Detection
1. mac-mini-agent Sentinel Protocol — https://deepwiki.com/disler/mac-mini-agent/4.3-sentinel-protocol
2. mac-mini-agent sentinel.py — https://github.com/disler/mac-mini-agent/blob/main/apps/drive/modules/sentinel.py
3. GitHub - tmux-sentinel — https://github.com/AveryRPeterson/tmux-sentinel
4. Command Execution (mac-mini-agent) — https://deepwiki.com/disler/mac-mini-agent/4.2-command-execution
5. tmux capture-pane man page — https://www.man7.org/linux/man-pages/man1/tmux.1.html

### Shell Readiness Race
6. Claude Code #23513 — https://github.com/anthropics/claude-code/issues/23513
7. Claude Code #37217 — https://github.com/anthropics/claude-code/issues/37217
8. Claude Code #40168 — https://github.com/anthropics/claude-code/issues/40168
9. Claude Code #33987 — https://github.com/anthropics/claude-code/issues/33987
10. crux #168 — https://github.com/yellowblue1/crux/issues/168
11. tmuxp workspace.builder — https://tmuxp.git-pull.com/api/workspace/builder/

### Terminal Multiplexer Pattern
12. tmux wait-for signaling — https://github.com/tmux/tmux/issues/832
13. Make tmux block until program completes — https://unix.stackexchange.com/questions/137426/make-tmux-block-until-program-completes
14. tmux pipe-pane documentation — https://tmuxai.dev/docs/guides/pipe-pane-output
15. tmux-pilot readiness detection — https://github.com/cmungall/tmux-pilot/issues/33
16. herdr CLI reference — https://herdr.dev/docs/cli-reference/
17. herdr wait output — tersedia via `herdr wait output --match <text>` (built-in blocking wait)
18. expect man page — https://man7.org/linux/man-pages/man1/expect.1.html

### Scrollback/Buffer
19. tmux history-limit — https://stackoverflow.com/questions/30413047/tmux-send-keys-command-appears-twice-on-the-screen
20. tmux capture-pane scrollback — https://stackoverflow.com/questions/25184643/how-to-wait-for-some-text-to-show-up-in-a-pane
