# pi-extension/subagents — Core Extension Module

## Purpose

The subagent extension for pi — spawn, orchestrate, and manage sub-agent sessions in tmux/herdr multiplexer panes. Fully non-blocking: main agent keeps working while subagents run in the background.

## Ownership

- **`mux.ts`** — tmux/herdr backend abstraction (createSurface, sendCommand, pollForExit, peekSurface, steerSurface, stripAnsi, cleanTerminalOutput, etc.)
- **`herdr-mux.ts`** — herdr backend resize functions. Height: herdrResizeStack, herdrGetPaneHeight. Width: herdrResizeWidths, herdrGetPaneWidth.
- **`tmux-mux.ts`** — tmux backend resize functions. Height: tmuxResizeStack, tmuxGetPaneHeight. Width: tmuxResizeWidths, tmuxGetPaneWidth.
- **`mux-layout.ts`** — layout engine for subagent panes (createTileSurface, equalizePanes, DEFAULT_SPLIT_RATIO). Supports tiling (DWM-style) and bottom-stack layouts via layoutMode parameter. State: lastSubagentSurface, stackPanes.
- **`monocle.ts`** — pure monocle layout engine for subagent panes (createMonocleSurface, resetMonocleLayout, getMonocleWindow). Every subagent gets its own dedicated fullscreen window/tab — no name grouping, no splits, no regex-based grouping. State: monocleWindows Map<surface, windowId>.
- **`enforce.ts`** — enforcement config builder (buildSubagentToolAllowlist, buildSubagentToolDenyArgs, resolveDenyTools, buildPiPromptArgs, resolveLaunchBehavior, resolveEffectiveInteractive, resolveEffectiveSessionMode). Pure config, no mux/I/O.
- **`shared.ts`** — shared lifecycle infra (surfaceReadiness, watchSubagent, runningSubagents, getModuleAbortSignal, updateWidget, startWidgetRefresh, setLatestCtx, generateRandomId). Used by both spin and resume.
- **`spin.ts`** — spawn lifecycle (launchSubagent, executeSubagentTool, createSubagentTool, renderSubagentCall/Result). Owns the complete new-sub-agent flow, including `--no-context-files` / `--no-skills` behaviors and lifecycle launch → poll for exit → close surface.
- **`resume.ts`** — resume lifecycle (executeSubagentResume, createSubagentResumeTool, renderSubagentResumeCall/Result, resolveResumeLaunchBehavior). Fixes P1: enforces tools/deny/agent via enforce.ts.
- **`types.ts`** — core type definitions (SubagentParams, RunningSubagent, SubagentResult, etc.)
- **`status.ts`** — subagent status state machine (starting → active → waiting → stalled) + config parsing (StatusConfig with enabled + lineLimit)
- **`activity.ts`** — subagent activity recording
- **`session.ts`** — session file management (read/write/merge)
- **`agent.ts`** — agent definition loading, defaults resolution, path resolution, config parsing
- **Tool/skill/extension override = append**: subagent-config.json `tools`/`skills`/`extensions` are ADDED to the agent .md base list (deduped), never replace it. `model` replaces. Evaluation order: tool arguments > project config > global config > frontmatter .md.
- **`prompt-inject.ts`** — `before_agent_start` hook that appends available sub-agents and active multiplexer environment context / steering guidance to the system prompt
- **`interrupt.ts`** — signal handling, live terminal peeking (`handleSubagentPeek`), and interactive steering (`handleSubagentSteer`) for running subagents
- **`renderers.ts`** — message renderers for result/status/stalled
- **`subagent-done.ts`** — subagent completion sidecar handler + the mandatory `subagent_done` self-termination tool (single exit path; no caller_ping)
- **`widget.ts`** — live widget rendering for the TUI. Child status (blocked/active tool counts) is shown directly in the widget with no keybinding (no Alt+= toggle).
- **`config.ts`** — per-agent resource override config (read/write/merge of subagent-config.json — static JSON, no wizard)
- **`test-slice.ts`** — exported test helpers

## Local Contracts

- `index.ts` is the extension entry point — registers tools, commands, message renderers, and widgets with pi
- All modules import from `./mux.ts` for multiplexer operations — never call tmux/herdr directly
- `mux-layout.ts` and `monocle.ts` are consumed by `mux.ts:createSurface()` — external callers use `createSurface(name, layout?)` only. Layout can be "tiling" (default), "bottom-stack", or "monocle". Falls back to config file if not passed explicitly.
- `spin.ts` owns the spawn lifecycle — launch → poll for exit → close surface. There is no separate `spawner.ts`.
- `spin.ts` passes `--no-context-files` for `worker` (doesn't need AGENTS.md), and `--no-skills` for all agents without explicit `skill:` frontmatter (reduces ~5k token bloat)
- **Agent sanitasi**: when `params.agent` is not passed explicitly, `spin.ts` first tries exact name match against agent definitions, then falls back to **prefix matching** — e.g. name "worker-fix-timer" resolves to "worker" agent defaults (tools, model, skills, mode). Implemented via `agent.ts:resolveAgentByPrefix()`.
- **Fallback ke worker**: ketika exact match AND prefix match gagal, sub-agent mendapat agent defaults `worker` utuh (tools: read,bash,write,edit, model: claude-sonnet-4-6, auto-exit, worker system prompt).
- **Default tool inheritance**: sub-agent mewarisi SEMUA tool yang tersedia di lingkungan Pi secara default (termasuk tool dari ekstensi lain). `buildSubagentToolAllowlist()` hanya menghasilkan `--tools` bila agent/params secara eksplisit mengonfigurasi `tools`; tanpa konfigurasi, tidak ada allowlist (full inherit). Tidak ada lagi fallback kaku `read,bash`.
- **Orchestrator tool denial selalu aktif**: `resolveDenyTools()` selalu men-deny `subagent`, `subagent_resume`, `subagent_interrupt`, `subagent_status`, `subagents_list`, `subagent_peek`, `subagent_steer` (lihat `types.ts:ORCHESTRATOR_TOOLS`), ditambah `deny-tools` frontmatter dan override project/global config. Diterapkan dua arah: argumen CLI `--exclude-tools` (via `buildSubagentToolDenyArgs()`) dan env `PI_DENY_TOOLS` (dibaca `index.ts` untuk skip registrasi tool).
- **Skill inheritance**: sub-agent mewarisi SEMUA skill secara default, kecuali agent secara eksplisit memiliki `skill:` frontmatter (maka `--no-skills` dipakai). `agents.<name>.skills` di config bersifat append (deduped).
- `prompt-inject.ts` guards orchestration notice via `PI_SUBAGENT_NAME` — only injects `<!-- subagent-orch-start -->` for the main agent, NOT sub-agents
- Agent `.md` files use `system-prompt: append`. The agent body appends role-specific focus and tool usage priorities to Pi's base prompt (which automatically provides tool descriptions and rules)
- Skills can be added per agent via `skill:` frontmatter in `.md`, or via `agents.<name>.skills` in `subagent-config.json`. Skills are injected as `/skill:name` prompt args. Custom extensions from frontmatter or config are NOT loaded — only `subagent-done.ts` is injected as the mandatory extension.
- `spin.ts` generates a raw subagent id via `generateRandomId`
- Status transitions go through `status.ts:advanceStatusState()` — never mutate statusState directly
- **Resume Tool & Agent Auto-Detection**: `resume.ts:resolveResumeAgent` automatically inspects the target session file's header for the original `agent` name via `session.ts:getSessionAgent`. Fallback chain: explicit `params.agent` → session header `agent` → prefix match → `worker` defaults. `resolveResumeTools` honors explicit `params.tools` as a `--tools` allowlist, otherwise the resumed session inherits the full environment tool surface. Orchestrator tools are always denied on resume.
- `subagent_status` tool returns a **live snapshot immediately on every call** — no rate limiting or throttling. Status changes are also auto-delivered as steers. Callers can poll as often as needed; each invocation recomputes state from `runningSubagents`.
- **Single exit via `subagent_done`**: an auto-exit sub-agent terminates itself exactly once by calling `subagent_done`, which writes the `.exit` sidecar. There is no `caller_ping` tool and no separate help-request path — the exit sidecar is the only child→parent completion channel.
- **Live monitoring via `subagent_peek`**: orchestrator can peek into a running subagent's terminal buffer at any time. Terminal output is automatically stripped of ANSI escape codes and normalized/compacted. Line count is clamped between 5 and 150 (default: 40) to prevent token bloat.
- **Live steering via `subagent_steer`**: orchestrator can inject text messages/guidance directly into a running subagent's terminal. Supports `interrupt: true` to send Escape first, aborting the active turn before delivering the steer message. If the subagent has already exited, the tool safely fails with a hint to use `subagent_resume`.
- **Multiplexer context injection**: `prompt-inject.ts` injects active multiplexer details (backend name, session, window/pane surface) and peek/steer steering guidance directly into the main agent's system prompt before each session.
- **Abort is manual**: running sub-agents are cancelled only through `subagent_interrupt` or session shutdown. There is no automatic stalled-subagent cleanup timer / auto-kill; the `stalled` status is a display-only state.

## Work Guidance

- Prefer pure functions with explicit dependencies over module-level state
- New mux operations go in `mux.ts`, new layout logic goes in `mux-layout.ts` or `monocle.ts` for window-based monocle layout
- Resize backends go in `herdr-mux.ts` and `tmux-mux.ts` — dispatch through closures in `mux.ts:createSurface()`
- All config/agent resolution goes through `agent.ts` and `config.ts`. Configuration is static JSON only: users edit `.pi/subagent-config.json` or `~/.pi/agent/subagent-config.json` directly. There is no interactive config wizard and no `/subagent-config` command.
- **Sub-agent prompt minimization**: every sub-agent inherits Pi base prompt with dynamic tool rules via `append`, strips project context via `--no-context-files` for worker, guards orchestration via `PI_SUBAGENT_NAME`; `--no-skills` is applied only when the agent explicitly configures skills. Custom extensions are disabled — only `subagent-done.ts` is injected.
- **Status tool has no rate limiting**: `subagent_status` always returns a fresh live snapshot on each call. There is no minimum interval, no backoff, and no snapshot cache. The `status` config object only carries `enabled` and `lineLimit`.
- **No IPC coordination plane**: there is no `send_messages` / check-messages tool and no delegate mode. Children communicate only through their exit sidecar; the orchestrator polls live status and resumes sessions.

## Verification

- Unit tests in `test/test.ts` cover: session.ts, status.ts, mux.ts (terminal output cleaning, stripAnsi, cleanTerminalOutput), interrupt (interrupt, handleSubagentPeek, handleSubagentSteer), renderers, widget, agent defaults, subagent-done, `subagent_status` live-snapshot behavior (immediate returns across repeated calls, no throttled flag), shared.ts export surface (throttle/backoff helpers removed), pure monocle layout, resume tool inheritance, prompt-inject orchestration tools & multiplexer context awareness, and config parsing (enabled, lineLimit, rejection of removed `minIntervalMs`)
- Run: `npm test`

## Child DOX Index

*(No child AGENTS.md files — this is a flat module directory.)*
