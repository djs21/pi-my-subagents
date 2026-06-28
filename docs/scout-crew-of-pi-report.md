# Laporan Scout: Crew-of-Pi Extension — Arsitektur & Cara Kerja

> **Sumber:** `/home/djs/.pi/agent/pluthenplay/extensions/crew-of-pi/`
> **Tipe:** Extension pi-coding-agent untuk orkestrasi sub-agent async non-blocking
> **Lisensi:** MIT
> **Versi:** 0.1.0

---

## 1. Ringkasan Arsitektur

Crew-of-pi adalah **extension pi-coding-agent** yang mengubah main agent menjadi **orchestrator read-only** yang mendelegasikan pekerjaan ke sub-agent spesialis. Sub-agent berjalan **async di background** dalam `AgentSession` terisolasi, masing-masing dengan context window, tools, extensions, dan skills sendiri.

### Prinsip Desain Utama

1. **Vertical Slice Architecture** — 10 slice independen, masing-masing memiliki satu tanggung jawab. Menambah/menghapus fitur cukup dengan satu import di `index.ts`.
2. **Read-Only Main Agent** — Tool `write` dan `edit` diblokir untuk main agent. Semua modifikasi file harus lewat sub-agent `worker`.
3. **Async Non-Blocking** — Sub-agent berjalan async via `createAgentSession()` dari SDK. Hasil dikirim sebagai **steering message**.
4. **Per-Agent Extensibility** — Setiap sub-agent bisa punya extensions, skills, dan model sendiri.
5. **In-Process AgentSession** — Sub-agent berlangsung dalam proses yang sama (shared runtime), bukan child process. Lebih hemat memori (~3-5x).

### Diagram Aliran Data

```
┌──────────────────────────────────────────────────────────┐
│                    MAIN PI SESSION                       │
│  Main Agent (orchestrator, READ-ONLY)                    │
│  ├── crew_spawn / crew_chain / crew_list / crew_abort   │
│  └── Hasil dikirim sebagai steering message              │
└──────────────────────────────────────────────────────────┘
         │                          ▲
         │ spawn (async)            │ steering message
         │ in-process AgentSession  │ (result)
         ▼                          │
┌──────────────────────────────────────────────────────────┐
│               ISOLATED SUBAGENT SESSIONS                  │
│  Worker | Scout | Planner | Reviewer | Researcher         │
│  (masing-masing: tools, model, extensions, skills beda)  │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Struktur Direktori

```
crew-of-pi/
├── index.ts                      # Entry point — mount semua slice
├── package.json                  # Metadata extension pi
├── AGENTS.md / CLAUDE.md         # DOX documentation
├── README.md                     # Dokumentasi lengkap
│
├── slices/                       # 10 vertical slices
│   ├── agents/                   # Discovery + Registry
│   ├── spawn/                    # Subagent spawn lifecycle
│   ├── blockers/                 # Tool interceptor (blok write/edit)
│   ├── prompt/                   # System prompt injection
│   ├── chain/                    # Sequential multi-agent workflow
│   ├── comms/                    # Inter-agent message bus
│   ├── lifecycle/                # abort / respond / done tools
│   ├── widget/                   # TUI status widget
│   ├── crew-list/                # crew_list tool
│   └── config/                   # /crew-of-pi config command
│
├── agents/                       # 5 bundled agent definitions (.md)
│   ├── worker.md                 # write/edit capability
│   ├── scout.md                  # codebase recon (read-only)
│   ├── planner.md                # implementation plan (read-only)
│   ├── researcher.md             # deep research (read-only)
│   └── reviewer.md               # code review (read-only)
│
├── prompts/                      # Workflow templates (/implement, /research)
│   ├── implement.md
│   └── research.md
│
└── shared/                       # Cross-slice type contracts
    └── types.ts                  # AgentConfig, SubagentHandle, UsageStats, dll
```

### Konvensi Penamaan

Setiap slice menggunakan pola `{slice}.{concern}.ts`:
- `agents.registry.ts` — query interface
- `agents.discovery.ts` — filesystem discovery
- `spawn.manager.ts` — spawn lifecycle logic
- `config.wizard.ts` — interactive wizard UI

---

## 3. Cara Kerja Sub-Agent Discovery & Registry

### 3.1. Agent Discovery Pipeline

File: `slices/agents/agents.discovery.ts`

Pipeline:
1. **Scan direktori** — cari file `.md` di tiga lokasi:
   - Bundled: `crew-of-pi/agents/` (bawaan extension)
   - User: `~/.pi/agent/agents/` (global user)
   - Project: `.pi/agents/` (per project, cari ke parent dir)

2. **Parse frontmatter YAML** — pakai `parseFrontmatter()` dari pi SDK. Ekstrak:
   - `name`, `description` — required
   - `tools`, `model`, `thinking`, `skills`, `extensions`
   - `interactive`, `compaction` — boolean flags

3. **Validasi** — model harus format `provider/model-id`, thinking level dari set valid, name tanpa whitespace.

4. **Priority merging** — higher priority override lower:
   - Project > User > Bundled

5. **Config overrides** — config `crew-of-pi.json` bisa override `model`, `tools`, `extensions`, `skills` per agent.

### 3.2. Agent Registry

File: `slices/agents/agents.registry.ts`

Class `AgentRegistry` — singleton in-memory:
- `agents: AgentConfig[]` — daftar agent yang ditemukan
- `runningAgents: Map<string, SubagentHandle>` — sub-agent yang sedang running
- Methods: `get()`, `getAll()`, `registerRunning()`, `updateRunning()`, `unregisterRunning()`, `getRunning()`
- Di-refresh di `session_start` dengan scope `"both"`
- Di-reset di `session_shutdown`

### 3.3. Extension Resolver

Ada 4 mode referensi extension per agent:
1. **Absolute path** — `/path/to/extension`
2. **Home expansion** — `~/path/to/extension`
3. **Relative path** — relatif terhadap lokasi file agent `.md`
4. **Pi package** — `npm:package-name` atau `git:repository-url`

---

## 4. Cara Kerja Sub-Agent Spawning

### 4.1. Spawn Tool

File: `slices/spawn/spawn.tool.ts`

Tool `crew_spawn`:
- Parameter: `agent`, `task`, `model`, `interactive`, `agentScope`, `cwd`
- Alur:
  1. Cari agent di registry — auto-refresh — direct discovery fallback
  2. Override model/interactive jika disediakan
  3. Panggil `spawnSubagentAsync()` — non-blocking, return segera dengan `subagent_id`
  4. Daftarkan handle ke registry
  5. Sync widget TUI
  6. Return response segera

### 4.2. Spawn Manager

File: `slices/spawn/spawn.manager.ts`

**spawnSubagentSession()** — synchronous spawn (blocking):
1. **Resolve model** — cari di `modelRegistry` berdasarkan `provider/model-id`
2. **Buat resource loader** — `DefaultResourceLoader` dengan extensions, skills, systemPrompt khusus agent
3. **Buat SettingsManager** — compaction sesuai config agent
4. **Buat AgentSession** — via SDK `createAgentSession()`
5. **Subscribe turn events** — lacak `usageAccum` (turns, tokens, cost)
6. **Kaitkan abort signal**
7. **Prompt** — kirim task ke sub-agent
8. **Determine outcome** — completed/failed/aborted
9. **Return** `{ output, session, sessionFile }`

**spawnSubagentAsync()** — async non-blocking wrapper:
1. Buat `AbortController` dedicated per sub-agent
2. Buat `SubagentHandle` dengan status `"spawned"`
3. Persist event `crew-subagent-spawn` ke session
4. **Concurrency limiter** — `ConcurrencyTracker` (max 4 antrian)
5. Hasil dikirim sebagai **steering message**
6. Persist hasil ke `crew-subagent-result`

### 4.3. Concurrency Tracker

```typescript
class ConcurrencyTracker {
  private max: number;      // MAX_CONCURRENCY = 4
  private current: number;
  private queue: Array<() => void>;
  async acquire(): Promise<void>
  release(): void
}
```

---

## 5. Cara Kerja Skill Integration

### 5.1. Per-Agent Skills

Skills didefinisikan di frontmatter agent `.md`:
```yaml
skills: /path/to/skill-dir, ~/.pi/agent/skills/tavily-search
```

Atau di `crew-of-pi.json` via config override.

### 5.2. Resource Loader

File: `slices/spawn/spawn.manager.ts` → `createSubagentResourceLoader()`

```typescript
additionalSkillPaths: agentConfig.skills && agentConfig.skills.length > 0
  ? agentConfig.skills
  : undefined,
```

Skills dilewatkan sebagai `additionalSkillPaths` ke `DefaultResourceLoader`.

### 5.3. Prompt Injection — Skill Awareness

File: `slices/prompt/prompt.injector.ts`

Fungsi `formatAgentEntry()` menambahkan skill ke system prompt main agent sehingga main agent tahu kemampuan setiap sub-agent.

### 5.4. Skill Path Expansion

Mendukung path file `SKILL.md` spesifik, direktori yang di-scan recursive, atau raw path string.

---

## 6. Cara Kerja Extension Management

### 6.1. Per-Agent Extension Loading

`DefaultResourceLoader` dengan `extensionsOverride` filter:
- Jika `agentConfig.extensions` kosong → semua extension di-filter out (no extensions mode)
- Jika ada → hanya load extension yang match dengan daftar agent

### 6.2. Config Wizard — Extension Discovery

`discoverExtensions()` mendeteksi dari 3 sumber:
1. `~/.pi/agent/extensions/` — folder-based
2. `~/.pi/agent/settings.json` — `packages[]` dari pi install
3. `~/.pi/agent/pluthenplay/extensions/` — dev extensions

### 6.3. Extension References

```typescript
interface AgentExtensionRef {
  type: "path" | "pi-package";
  value: string;
  resolved?: string;
}
```

---

## 7. System Prompt Injection

File: `slices/prompt/prompt.injector.ts`

**Hook:** `pi.on("before_agent_start", ...)`

Inject ke system prompt main agent:
1. **Crew header** — "You are a MAIN ORCHESTRATOR agent..."
2. **Agent list** — nama, deskripsi, model, tools, skills, extensions
3. **Delegation rules** — 12 aturan (read-only, delegasi ke sub-agent sesuai perannya)
4. **Custom instructions** — dari config

---

## 8. Blockers — Tool Interceptor

File: `slices/blockers/blockers.intercept.ts`

**Hook:** `pi.on("tool_call", ...)`

- Mencegat `write` dan `edit` — diblokir
- Bisa blokir bash destructive commands
- Policy bisa dikonfigurasi via `crew-of-pi.json`

Default: `DEFAULT_MAIN_AGENT_DISABLED_TOOLS = ["write", "edit"]`

---

## 9. Chain Workflow

File: `slices/chain/chain.orchestrator.ts` dan `chain.tool.ts`

Tool `crew_chain` — sequential multi-agent workflow.

### Per Step:
1. Replace `{previous}` dengan output step sebelumnya
2. Find agent config
3. Augment task dengan bus messages + marker instructions
4. Spawn sub-agent (blocking per step — chain is sequential)
5. Parse markers `[ASK]`, `[TELL]`, `[HANDOFF]`, `[WAIT]`
6. Route markers ke message bus
7. Pass clean text ke step berikutnya

### Inter-Agent Marker Protocol:
```
[ASK to:agent] question
[TELL to:agent] message  
[HANDOFF to:agent] context
[WAIT] reason
```

---

## 10. Inter-Agent Communication (Message Bus)

File: `slices/comms/comms.ts`

### MessageBus — singleton event bus:
- `send(from, to, type, content)`
- `getMessagesFor(recipientId)`
- `subscribe(channel, handler)`

### Persistence:
- `restoreBusState()` — restore dari session entries
- `persistMessage()` — simpan ke session entry (`crew-bus-message`)

### Relay:
- `registerCommsRelay()` — relay ke main agent sebagai steering message
- `respondToSubagent()` — response dari main ke sub-agent
- `broadcastToAll()` — broadcast ke semua sub-agent

---

## 11. Lifecycle Management

### crew_abort (lifecycle.abort.ts)
- `abortController.abort()` → `session.abort()` → `session.dispose()`
- Single (`subagent_id`) atau all (`all: true`)
- Ownership validation

### crew_respond (lifecycle.respond.ts)
- Kirim follow-up ke interactive sub-agent via bus + session prompt
- Validasi: agent harus interactive dan owned

### crew_done (lifecycle.done.ts)
- Close interactive session via `doneSubagent()`

### Lifecycle Shared (lifecycle.shared.ts)
- `validateOwnership()` — handle exists + belongs to caller session
- `doneSubagent()` — mark completed, persist, sync widget

---

## 12. TUI Widget

File: `slices/widget/`

- **widget.types.ts** — WidgetRow, WidgetState, MAX_WIDGET_ROWS=10, MAX_SETTLED_ROWS=4
- **widget.store.ts** — WidgetStore singleton
- **widget.renderer.ts** — Render dengan spinner animation (80ms)
- **widget.updater.ts** — Centralized refresh callback, `syncWidgetFromRegistry()`

---

## 13. Config System

File: `slices/config/`

### `/crew-of-pi config` — Slash Command
Interaktif wizard untuk edit `crew-of-pi.json`:
- Model picker (fuzzy-searchable)
- Extensions picker (dari installed + custom path)
- Skills picker (dari installed + custom path)
- Main agent tool policy toggle
- Tab completion

### Config File Locations
- Global: `~/.pi/agent/crew-of-pi.json`
- Project: `.pi/crew-of-pi.json` (override global)

---

## 14. Bundled Agent Definitions

| Agent | Tools | Role |
|-------|-------|------|
| worker | read, write, edit, grep, find, ls, bash | Implementasi kode |
| scout | read, grep, find, ls, bash | Codebase reconnaissance |
| planner | read, grep, find, ls | Implementation planning (read-only) |
| researcher | read, grep, find, ls, bash | Deep research |
| reviewer | read, grep, find, ls, bash | Code review |

Semua menggunakan `use caveman full` untuk hemat token. Masing-masing punya output format terstruktur.

---

## 15. Lifecycle Hooks & Entry Points

| Hook | File | Purpose |
|------|------|---------|
| `session_start` | `index.ts` | Init: registry, infra, config, restore, warnings |
| `session_shutdown` | `index.ts` | Dispose owned sessions, reset singletons |
| `before_agent_start` | `prompt.injector.ts` | Inject crew info ke system prompt |
| `tool_call` | `blockers.intercept.ts` | Blok write/edit |

**Tools registered:** crew_spawn, crew_chain, crew_abort, crew_respond, crew_done, crew_list

**Command:** /crew-of-pi

**Widget:** "crew-status"

---

## 16. Pola-Pola Kunci yang Bisa Direplikasi

### 1. Vertical Slice Architecture
Setiap fitur adalah slice independen: types → logic → tool registration. Slices dikomunikasikan via shared types.

### 2. Singleton + Reset Pattern
```typescript
let _instance = null;
export function getInstance() { ... }
export function resetInstance() { _instance = null; }
```
Semua stateful service di-reset di session_shutdown.

### 3. Tool Registration Pattern
```typescript
pi.registerTool({
  name, label, description,
  parameters: Type.Object({...}),
  execute(params, signal, onUpdate, ctx) { ... },
  renderCall(args, theme) { ... },
  renderResult(result, options, theme) { ... },
});
```

### 4. Async Non-Blocking with Steering Delivery
Sub-agent di-spawn async, return immediate. Hasil via `pi.sendMessage({...}, { deliverAs: "steer" })`. Anti-polling warning di `crew_list`.

### 5. Per-Agent Extension Filtering
Default no extensions. Hanya load extension yang terdaftar di frontmatter agent.

### 6. Config Override Chain
Project config > User config > Bundled defaults.

### 7. Ownership Validation
Setiap sub-agent dicatat dengan `ownerSession`. Hanya session pemilik yang bisa mengelola sub-agent tersebut.

---

## 17. File-File Penting & Perannya

| File | Peran |
|------|-------|
| `index.ts` | Entry point — mount semua slice, init session handlers |
| `package.json` | Metadata extension pi: entry point, prompts |
| `shared/types.ts` | Cross-slice type contracts |
| `slices/agents/agents.discovery.ts` | Discovery pipeline: scan, parse, validasi, merge |
| `slices/agents/agents.registry.ts` | In-memory registry singleton |
| `slices/spawn/spawn.manager.ts` | Subagent lifecycle: session creation, turn tracking |
| `slices/spawn/spawn.tool.ts` | crew_spawn tool — async non-blocking |
| `slices/blockers/blockers.intercept.ts` | Tool call interceptor — blok write/edit |
| `slices/prompt/prompt.injector.ts` | System prompt injection |
| `slices/chain/chain.orchestrator.ts` | Sequential chain with {previous} + markers |
| `slices/chain/chain.tool.ts` | crew_chain tool |
| `slices/comms/comms.ts` | Message bus + persistence + relay |
| `slices/lifecycle/*.ts` | abort, respond, done tools + ownership validation |
| `slices/crew-list/crew-list.tool.ts` | crew_list tool |
| `slices/config/*.ts` | /crew-of-pi config: wizard, helpers, model selector |
| `slices/widget/*.ts` | TUI widget: store, renderer, updater |
| `agents/*.md` | 5 bundled agent definitions (frontmatter + system prompt) |
| `prompts/implement.md` | Workflow template scout→planner→worker |
