# Perbandingan Spawning Sub-agent di tmux: Original vs Current

**Codebase A (Original):** https://github.com/HazAT/pi-interactive-subagents (v3.7.2, commit `c100577`)
**Codebase B (Current):** `/home/djs/project/pi-my-subagents/pi-extension/subagents/`

Laporan ini membandingkan pendekatan tmux-specific code untuk spawning sub-agent. Fokus pada file `cmux.ts` (A) vs `mux.ts` + `tmux-mux.ts` + `mux-layout.ts` (B).

---

## 1. Pane Creation (split-window)

### Codebase A — Original (`cmux.ts:createSurfaceSplit`)

```typescript
// tmux branch di createSurfaceSplit()
const args = ["split-window", "-d"];
if (direction === "left" || direction === "right") args.push("-h");
else args.push("-v");
if (direction === "left" || direction === "up") args.push("-b");
if (fromSurface) args.push("-t", fromSurface);
args.push("-P", "-F", "#{pane_id}");
const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
return pane;
```

- **Tanpa ratio** (`-p` flag) — split selalu 50/50 default tmux
- **target pane** hanya di-set jika `fromSurface` diberikan (optional)
- **Validasi output**: throws error jika output tidak mulai dengan `%`
- **Panggilan `createSurface()`**: untuk tmux, `fromSurface = process.env.TMUX_PANE` (parent pi's pane)

### Codebase B — Current (`mux.ts:createSurfaceSplit`)

```typescript
// tmux branch di createSurfaceSplit()
const args = ["split-window", "-d"];
if (direction === "left" || direction === "right") args.push("-h");
else args.push("-v");
if (direction === "left" || direction === "up") args.push("-b");
if (ratio !== undefined) args.push("-p", String(Math.round(ratio * 100)));
const target = fromSurface ?? process.env.TMUX_PANE;
if (target) args.push("-t", target);
args.push("-P", "-F", "#{pane_id}");
const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
return pane;
```

- **Dengan ratio** (`-p` flag) — split dapat dikontrol dengan `DEFAULT_SPLIT_RATIO = 0.30` (subagent dapat 30%, parent 70%)
- **target pane selalu di-set** — fallback ke `process.env.TMUX_PANE`
- **Validasi output**: sama, throw error jika tidak `%`
- **Panggilan `createSurface()`**: melalui `createTileSurface()` yang mengatur layout

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| Ratio split | Tidak ada (50/50) | Ada (30/70 default) |
| Target pane | Optional (`-t` hanya jika `fromSurface`) | Selalu (`-t` dengan fallback ke `TMUX_PANE`) |
| Layout | Tidak ada abstraksi layout | `createTileSurface()` + DWM tile |
| Validasi output | `startsWith("%")` | `startsWith("%")` |

### Rekomendasi

✅ **Ratio split di B lebih baik** — memberi kontrol layout yang lebih baik. Pertahankan.

---

## 2. Command Delivery (send-keys vs lainnya)

### Codebase A — Original (`cmux.ts:sendCommand`)

```typescript
// tmux branch
execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
```

- Dua langkah: `send-keys -l` (literal) + `send-keys Enter`
- **Tanpa delay** antara command dan Enter

### Codebase B — Current (`mux.ts:sendCommand`)

```typescript
// tmux branch — IDENTIK
execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
```

- **Sama persis** pendekatannya

### Long Command (script file approach)

Keduanya menggunakan `sendLongCommand()` yang menulis script ke file `.sh`, lalu menjalankannya dengan `bash <script>`:

```typescript
sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
```

**Perbedaan kecil di B**: untuk herdr backend, menggunakan `herdr pane run surface "bash <script>"` langsung, bukan melalui `sendCommand()`. Untuk tmux, sama.

### Shell Readiness

Keduanya punya `getShellReadyDelayMs()` — delay 500ms setelah pane dibuat sebelum mengirim command. **Tidak ada prompt detection** di kedua codebase.

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| send-keys approach | `-l` + Enter (identical) | `-l` + Enter (identical) |
| Shell readiness | 500ms fixed delay | 500ms fixed delay |
| Script-based long cmd | `bash <script>` via sendCommand | `bash <script>` via sendCommand (same) |

### Rekomendasi

⚠️ **Keduanya rentan terhadap race condition** — jika shell lambat (direnv, nvm, dll), command bisa hilang. Tidak ada perbaikan di A yang belum ada di B.

---

## 3. Sentinel / Exit Detection (pollForExit)

### Codebase A — Original (`cmux.ts:pollForExit`)

```typescript
// Fast path: .exit sidecar file
const exitFile = `${options.sessionFile}.exit`;
if (existsSync(exitFile)) {
  const data = JSON.parse(readFileSync(exitFile, "utf8"));
  rmSync(exitFile, { force: true });
  return interpretExitSidecar(data);
}

// Claude sentinel file (opsional)
if (options.sentinelFile) { ... }

// Slow path: terminal sentinel
const screen = await readScreenAsync(surface, 5);
const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };

// Fallback: jika readScreen error, cek .exit file sekali lagi
```

- **3 jalur**: `.exit` sidecar, Claude sentinel file, terminal sentinel
- **readScreenAsync(surface, 5)** — hanya baca 5 lines terakhir
- **Fallback**: jika `readScreenAsync` throw, cek `.exit` file lagi
- **InterpretExitSidecar()**: centralized decoder untuk payload `.exit`

### Codebase B — Current (`mux.ts:pollForExit`)

```typescript
// Fast path: .exit sidecar file — IDENTIK
const exitFile = `${options.sessionFile}.exit`;
if (existsSync(exitFile)) {
  const data = JSON.parse(readFileSync(exitFile, "utf8"));
  rmSync(exitFile, { force: true });
  return interpretExitSidecar(data);
}

// Slow path: terminal sentinel — IDENTIK
const screen = await readScreenAsync(surface, 5);
const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
if (match) return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
```

- **2 jalur**: `.exit` sidecar + terminal sentinel
- **Tidak ada Claude sentinel file support**
- Kode `interpretExitSidecar()` identik

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| Fast path (.exit sidecar) | ✅ Ada | ✅ Ada (identik) |
| Claude sentinel file | ✅ Ada | ❌ Tidak ada |
| Terminal sentinel (5 lines) | ✅ Ada | ✅ Ada (identik) |
| Fallback after readScreen error | ✅ Cek .exit lagi | ✅ Cek .exit lagi |

### Rekomendasi

✅ **Sentinel logic B sudah setara dengan A** untuk non-Claude case. Untuk Claude support, diperlukan tambahan `sentinelFile` option di `PollResult` dan logika `copyClaudeSession()`.

---

## 4. Error Handling

### Codebase A — Original

- **Validasi output tmux**: throw error jika output split-window tidak `%`
- **Zellij retry**: loop 3x untuk `readZellijPanes()`, dengan 50ms sleep antar attempt
- **Zellij surface lock**: mkdir-based lock dengan timeout 10s, stale lock cleanup 30s
- **cmux focus restore**: try/catch untuk pane verification, silent skip jika pane hilang
- **catch {}** digunakan di: sentinel check, exit sidecar read, closeSurface, renameSurface, renameCurrentTab, renameWorkspace (konsisten — operasi non-kritis tidak throw)

### Codebase B — Current

- **Validasi output tmux**: sama, throw error jika tidak `%`
- **herdr**: JSON parsing dengan fallback, **tanpa retry**
- **Layout resize**: `catch {}` untuk pane yang sudah closed
- **catch {}** digunakan di: sentinel check, exit sidecar read, closeSurface, renameSurface, resize operations

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| Validasi tmux output | ✅ `startsWith("%")` | ✅ `startsWith("%")` |
| Retry logic | ✅ Zellij 3x retry | ❌ Tidak ada herdr retry |
| Surface lock | ✅ Zellij mkdir lock | ❌ Tidak ada |
| Error logging | ❌ Silent `catch {}` | ❌ Silent `catch {}` (sama) |

### Rekomendasi

⚠️ **Keduanya punya masalah yang sama**:
1. Silent `catch {}` di banyak tempat menyulitkan debugging
2. Tidak ada logging untuk mux operation failures
3. B tidak punya retry untuk herdr operations (mirip zellij retry di A)

Yang bisa diadopsi: pola **retry + surface lock** untuk herdr jika herdr juga punya race condition seperti zellij.

---

## 5. Environment Variables

### Codebase A — Original

```typescript
envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
```

### Codebase B — Current

```typescript
// Sama persis + tambahan:
// (dari spawner.ts -> buildAgentResourceArgs di agent.ts)
if (agentDefs) {
  const resourceArgs = buildAgentResourceArgs(agentDefs, effectiveAgentDir);
  parts.push(...resourceArgs); // --no-extensions, -e untuk extensions spesifik
}
```

- **Tambahan B**: Per-agent extensions/skills via `buildAgentResourceArgs()` — bisa override extensions dan skills per agent definition
- **Tambahan B**: Config system (`subagent-config.json`) untuk per-agent overrides (extensions, skills, model)

### Rekomendasi

✅ B lebih unggul dengan per-agent resource overrides. Pertahankan.

---

## 6. Layout Management

### Codebase A — Original

Tidak ada layout abstraction generik. Setiap backend punya approach sendiri:
- **cmux**: right-split pertama, lalu tabs di pane yang sama (`createSurfaceInPane`)
- **tmux**: selalu right-split, tidak ada tracking untuk layout berikutnya
- **zellij**: placement planning canggih dengan `selectZellijPlacement()` — bisa split atau stack tergantung ukuran pane
- **Tidak ada equalization** — panes tidak di-resize setelah dibuat

### Codebase B — Current

Punya layout system eksplisit:

```typescript
// mux-layout.ts — DWM-style tile layout
// First subagent: split main pane RIGHT (30/70)
// Subsequent: split previous subagent DOWN (equal heights)
// result: main agent on left, subagents stacked on right
```

- **Dua layout mode**: `tiling` (DWM-style) dan `bottom-stack`
- **equalizePanes()**: resize semua panes ke height/width yang sama
- **resetLayout()**: reset tracking `lastSubagentSurface` dan `stackPanes`
- **Layout recovery**: jika tracked pane hilang, reset dan retry right-split dari main pane
- **Configurable**: via `subagent-config.json` (`layout` field)

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| Layout abstraction | ❌ Tidak ada | ✅ `mux-layout.ts` dengan DWM tile |
| Equalization | ❌ Tidak ada | ✅ `equalizePanes()` |
| Layout modes | ❌ Satu mode per backend | ✅ `tiling` + `bottom-stack` |
| Layout config | ❌ Tidak ada | ✅ `subagent-config.json` |
| Layout recovery | ❌ Tidak ada | ✅ Reset on pane loss |
| Zellij placement | ✅ Canggih (split/stack) | N/A (tidak support zellij) |

### Rekomendasi

✅ **B lebih unggul untuk tmux/herdr** dengan layout system yang jelas. A lebih unggul untuk zellij dengan placement planning yang adaptif.

---

## 7. Shell Compatibility (fish/zsh/bash)

### Codebase A — Original

```typescript
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}
```

- Fungsi `exitStatusVar()` didefinisikan tapi **tidak pernah dipakai** — sentinel hardcoded `$?`

### Codebase B — Current

```typescript
// IDENTIK — fungsi yang sama, juga tidak pernah dipakai
```

### Perbandingan

**Sama persis** — kedua codebase punya fungsi `isFishShell()` dan `exitStatusVar()` yang tidak digunakan. Sentinel string masih `'__SUBAGENT_DONE_'$?'__'` yang hanya bekerja di bash/zsh.

### Rekomendasi

⚠️ **Keduanya bermasalah untuk fish shell** — sentinel tidak akan berfungsi karena fish menggunakan `$status`, bukan `$?`. Jika fish support diperlukan, sentinel harus menggunakan `exitStatusVar()`.

---

## 8. Arsitektur & Organisasi Kode

### Codebase A — Original (4 files utama)

```
pi-extension/subagents/
├── cmux.ts          # Semua mux backend logic (800+ lines)
├── session.ts       # Session file management
├── status.ts        # Status tracking
├── activity.ts      # Activity file management
├── index.ts         # Tool registration, launch, watch, widget
└── subagent-done.ts # Subagent completion detection
```

### Codebase B — Current (~15 files)

```
pi-extension/subagents/
├── mux.ts           # Core mux ops (create, send, read, close)
├── tmux-mux.ts      # TMUX-specific resize helpers
├── herdr-mux.ts     # Herdr-specific resize helpers
├── mux-layout.ts    # Layout management (DWM tile, bottom-stack)
├── spawner.ts       # Launch + watch lifecycle
├── agent.ts         # Agent definition parsing, discovery
├── config.ts        # subagent-config.json system
├── types.ts         # Pure type definitions
├── session.ts       # Session file management
├── status.ts        # Status tracking
├── activity.ts      # Activity file management
├── subagent.ts      # Subagent tool creation
├── interrupt.ts     # Interrupt handling
├── widget.ts        # Widget rendering
├── renderers.ts     # Message renderers
├── commands.ts      # CLI commands (/plan, /subagent, etc.)
├── index.ts         # Entry point — wiring only
└── subagent-done.ts # Subagent completion detection
```

### Perbandingan

| Aspek | A (Original) | B (Current) |
|---|---|---|
| Modularity | Monolitik (`cmux.ts` 800+ lines) | Sangat modular |
| Separation of concerns | Mux logic + session + status + widget di index.ts | Dipisah per file |
| Type definitions | Inline di index.ts | `types.ts` dedicated |
| Testability | Lebih sulit (tight coupling) | Lebih mudah (dependency injection) |

### Rekomendasi

✅ **Arsitektur B lebih baik** untuk maintainability. Namun perlu dicatat bahwa A lebih ringkas, mungkin lebih mudah dipahami secara keseluruhan.

---

## 9. Fitur Unik Per Codebase

### Hanya di Codebase A (Original)

| Fitur | File | Deskripsi |
|---|---|---|
| **Claude Code support** | `index.ts` | CLI agent dengan sentinel file, plugin dir, session transcript copy |
| **Zellij support** | `cmux.ts` | Full zellij: pane creation, stacking, tab management, surface lock |
| **WezTerm support** | `cmux.ts` | split-pane, send-text, get-text, kill-pane |
| **cmux support** | `cmux.ts` | Full cmux: split, tab, focus save/restore, rename |
| **Focus management** | `cmux.ts` | `captureCmuxIdentifySnapshot()` + `restoreCmuxFocusSnapshot()` |
| **Session forking** | `session.ts` | Fork mode dengan `getForkContentLines()` |
| **renameCurrentTab/Workspace** | `cmux.ts` | Rename tab/workspace untuk semua backend |

### Hanya di Codebase B (Current)

| Fitur | File | Deskripsi |
|---|---|---|
| **herdr support** | `herdr-mux.ts`, `mux.ts` | Full herdr: pane split, run, read, close, resize |
| **Layout system** | `mux-layout.ts` | DWM tile + bottom-stack dengan equalization |
| **Equalize panes** | `mux-layout.ts` | Resize all panes ke height/width yang sama |
| **Config system** | `config.ts` | `subagent-config.json` dengan per-agent overrides |
| **Per-agent extensions** | `agent.ts` | `buildAgentResourceArgs()` untuk extensions/skills spesifik |
| **Layout recovery** | `mux-layout.ts` | Reset layout jika pane hilang |
| **Types file** | `types.ts` | Dedicated type definitions |
| **Pane rename** | `mux.ts` | `renameSurface()` — best-effort label pada pane |
| **Agent auto-resolve** | `spawner.ts` | Case-insensitive agent lookup, fallback ke name |

---

## 10. Masalah yang Diidentifikasi Scout Sebelumnya

### Sentinel 5 Lines Problem

**Status di kedua codebase**: MASIH ADA. Keduanya membaca 5 lines terakhir dengan `readScreenAsync(surface, 5)`. Jika terminal output lebih dari 5 lines sebelum sentinel muncul, sentinel tidak akan terdeteksi.

**A (Original)**: Menggunakan `tailLines()` di readScreen async, tapi untuk tmux menggunakan `capture-pane -S -5`. **Tidak ada perbaikan.**

**B (Current)**: Sama, `capture-pane -S -5`. **Tidak ada perbaikan.**

**Rekomendasi**: Tidak ada yang bisa diadopsi dari A untuk masalah ini. Perlu fix sendiri — misalnya membaca lebih banyak lines atau mencari sentinel di seluruh output.

### send-keys Race Condition

**Status di kedua codebase**: MASIH ADA. Keduanya mengandalkan delay fixed 500ms (`getShellReadyDelayMs()`) setelah pane dibuat. Tidak ada prompt detection.

**A (Original)**: Delay 500ms, tidak ada prompt detection.
**B (Current)**: Delay 500ms, tidak ada prompt detection.

**Rekomendasi**: Tidak ada yang bisa diadopsi dari A. Perlu pendekatan berbeda (misalnya prompt detection via `capture-pane`).

### Silent Error Handling

**Status di kedua codebase**: SAMA. Keduanya menggunakan `catch {}` ekstensif.

**A (Original)**: `catch {}` di sentinel check, exit sidecar, closeSurface, rename, zellij ops.
**B (Current)**: `catch {}` di sentinel check, exit sidecar, closeSurface, rename, resize ops.

**Rekomendasi**: Tidak ada yang lebih baik dari A. Keduanya sama.

---

## Ringkasan Akhir

### Yang B (Current) Lakukan LEBIH BAIK dari A (Original)

1. **Layout management** — DWM tile + bottom-stack dengan equalization
2. **Ratio split** — 30/70 default vs 50/50 di A
3. **Modular architecture** — Separation of concerns lebih baik
4. **Config system** — `subagent-config.json` untuk per-agent overrides
5. **Per-agent resources** — Extensions/skills spesifik per agent
6. **Layout recovery** — Reset otomatis jika pane hilang
7. **Target pane always set** — Selalu `-t` dengan fallback `TMUX_PANE`

### Yang A (Original) Lakukan LEBIH BAIK dari B (Current)

1. **Multi-backend support** — cmux, tmux, zellij, wezterm vs hanya herdr + tmux
2. **Zellij placement planning** — Adaptive split vs stack berdasarkan ukuran terminal
3. **Claude Code integration** — Complete claude CLI subagent support
4. **cmux focus management** — Save/restore focus setelah split creation
5. **Surface lock for zellij** — mencegah race condition saat zellij pane creation
6. **Retry logic** — 3x retry untuk zellij operations

### Yang BISA DIADOPASI dari A untuk B

| Prioritas | Fitur | Dampak | Estimasi Usaha |
|---|---|---|---|
| 🔴 Tinggi | **Retry logic untuk herdr operations** | Mengurangi race condition | 1-2 jam |
| 🟡 Sedang | **Focus save/restore** (jika cmux nanti) | UX lebih baik | 2-3 jam |
| 🟡 Sedang | **Surface lock pattern** untuk herdr | Mencegah race condition | 2-3 jam |
| 🟢 Rendah | **Claude Code CLI support** | Fitur baru | 4-6 jam |
| 🟢 Rendah | **WezTerm support** | Fitur baru | 2-3 jam |

### Kesimpulan

**Codebase B lebih matang untuk tmux-specific use case** dengan layout management, ratio split, dan modular architecture. **Codebase A lebih matang untuk multi-backend support** dengan zellij/wezterm/cmux. Keduanya memiliki masalah yang sama pada sentinel detection (5 lines) dan race condition (fixed delay).

Tidak ada terobosan signifikan di A yang belum diadopsi B untuk tmux-specific path. Nilai utama A adalah pada dukungan backend lain dan fitur-fitur spesifik seperti Claude Code dan zellij placement planning.
