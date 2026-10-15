# pi-extension/subagents — Core Extension Module

## Purpose

The subagent extension for pi — spawn, orchestrate, and manage sub-agent sessions in tmux/herdr multiplexer panes. Fully non-blocking: main agent keeps working while subagents run in the background.

## Ownership

- **`mux.ts`** — tmux/herdr backend abstraction (createSurface, sendCommand, pollForExit, etc.)
- **`herdr-mux.ts`** — herdr backend resize functions. Height: herdrResizeStack, herdrGetPaneHeight. Width: herdrResizeWidths, herdrGetPaneWidth.
- **`tmux-mux.ts`** — tmux backend resize functions. Height: tmuxResizeStack, tmuxGetPaneHeight. Width: tmuxResizeWidths, tmuxGetPaneWidth.
- **`mux-layout.ts`** — layout engine for subagent panes (createTileSurface, equalizePanes, DEFAULT_SPLIT_RATIO). Supports tiling (DWM-style) and bottom-stack layouts via layoutMode parameter. State: lastSubagentSurface, stackPanes.
- **`monocle.ts`** — monocle layout engine for subagent panes (createMonocleSurface, equalizeMonoclePanes, resetMonocleLayout, getGroupName). First subagent of a type creates a new window; subsequent subagents of same type share that window with equalized heights. State: monocleState Map<string, MonocleGroup>.
- **`enforce.ts`** — enforcement config builder (buildSubagentToolAllowlist, buildSubagentToolDenyArgs, resolveDenyTools, buildPiPromptArgs, resolveLaunchBehavior, resolveEffectiveInteractive, resolveEffectiveSessionMode). Pure config, no mux/I/O.
- **`shared.ts`** — shared lifecycle infra (surfaceReadiness, watchSubagent, runningSubagents, getModuleAbortSignal, updateWidget, startWidgetRefresh, setLatestCtx, generateRandomId). Used by both spin and resume.
- **`spin.ts`** — spawn lifecycle (launchSubagent, executeSubagentTool, createSubagentTool, renderSubagentCall/Result). Owns the complete new-sub-agent flow.
- **`resume.ts`** — resume lifecycle (executeSubagentResume, createSubagentResumeTool, renderSubagentResumeCall/Result, resolveResumeLaunchBehavior). Fixes P1: enforces tools/deny/agent via enforce.ts.
- **`types.ts`** — core type definitions (SubagentParams, RunningSubagent, SubagentResult, etc.)
- **`status.ts`** — subagent status state machine (starting → active → waiting → stalled) + config parsing (StatusConfig with enabled + lineLimit)
- **`activity.ts`** — subagent activity recording
- **`session.ts`** — session file management (read/write/merge)
- **`agent.ts`** — agent definition loading, defaults resolution, path resolution, config parsing
- **Tool/skill/extension override = append**: subagent-config.json `tools`/`skills`/`extensions` are ADDED to the agent .md base list (deduped), never replace it. Wizard "Available" list shows only tools not already effective. Wizard "Active" shows base .md tools as 🔒 locked (not removable) plus JSON additions; "Available" = registered tools not yet effective. Skills editor matches base frontmatter skill names by folder basename.
- **`prompt-inject.ts`** — `before_agent_start` hook that appends available sub-agents to the system prompt
- **`interrupt.ts`** — interrupt/signal handling for running subagents
- **`renderers.ts`** — message renderers for result/status/ping/stalled
- **`subagent-done.ts`** — subagent completion sidecar handler + caller_ping help-request tool
- **`widget.ts`** — live widget rendering for the TUI
- **`config.ts`** — per-agent resource override config
- **`commands.ts`** — pi commands (subagent config)
- **`discovery.ts`** — discovery of agents, extensions, skills, and models
- **`test-slice.ts`** — exported test helpers

## Local Contracts

- `index.ts` is the extension entry point — registers tools, commands, message renderers, and widgets with pi
- All modules import from `./mux.ts` for multiplexer operations — never call tmux/herdr directly
- `mux-layout.ts` and `monocle.ts` are consumed by `mux.ts:createSurface()` — external callers use `createSurface(name, layout?)` only. Layout can be "tiling" (default), "bottom-stack", or "monocle". Falls back to config file if not passed explicitly.
- `spawner.ts` exports `launchSubagent()` and `watchSubagent()` — lifecycle is: launch → poll for exit → close surface
- `spawner.ts` passes `--no-context-files` for `worker` (doesn't need AGENTS.md), and `--no-skills` for all agents without explicit `skill:` frontmatter (reduces ~5k token bloat)
- **Agent sanitasi**: when `params.agent` is not passed explicitly, `spin.ts` first tries exact name match against agent definitions, then falls back to **prefix matching** — e.g. name "worker-fix-timer" resolves to "worker" agent defaults (tools, model, skills, mode). Implemented via `agent.ts:resolveAgentByPrefix()`.
- **Fallback ke worker**: ketika exact match AND prefix match gagal, sub-agent mendapat agent defaults `worker` utuh (tools: read,bash,write,edit, model: claude-sonnet-4-6, auto-exit, worker system prompt).
- **Default tool inheritance**: sub-agent mewarisi SEMUA tool yang tersedia di lingkungan Pi secara default (termasuk tool dari ekstensi lain). `buildSubagentToolAllowlist()` hanya menghasilkan `--tools` bila agent/params secara eksplisit mengonfigurasi `tools`; tanpa konfigurasi, tidak ada allowlist (full inherit). Tidak ada lagi fallback kaku `read,bash`.
- **Orchestrator tool denial selalu aktif**: `resolveDenyTools()` selalu men-deny `subagent`, `subagent_resume`, `subagent_interrupt`, `subagent_status`, `subagents_list` (lihat `types.ts:ORCHESTRATOR_TOOLS`), ditambah `deny-tools` frontmatter dan override project/global config. Diterapkan dua arah: argumen CLI `--exclude-tools` (via `buildSubagentToolDenyArgs()`) dan env `PI_DENY_TOOLS` (dibaca `index.ts` untuk skip registrasi tool).
- `prompt-inject.ts` guards orchestration notice via `PI_SUBAGENT_NAME` — only injects `<!-- subagent-orch-start -->` for the main agent, NOT sub-agents
- Agent `.md` files use `system-prompt: replace` (was `append`). The agent body IS the complete system prompt — must embed tool definitions and usage guidelines
- Skills can be added per agent via `skill:` frontmatter in `.md`, or via `agents.<name>.skills` in `subagent-config.json`. Skills are injected as `/skill:name` prompt args. Custom extensions from frontmatter or config are NOT loaded — only `subagent-done.ts` is injected as the mandatory extension.
- `spin.ts` generates a raw subagent id via `generateRandomId`
- Status transitions go through `status.ts:advanceStatusState()` — never mutate statusState directly
- **Resume Tool & Agent Auto-Detection**: `resume.ts:resolveResumeAgent` automatically inspects the target session file's header for the original `agent` name via `session.ts:getSessionAgent`. Fallback chain: explicit `params.agent` → session header `agent` → prefix match → `worker` defaults. `resolveResumeTools` honors explicit `params.tools` as a `--tools` allowlist, otherwise the resumed session inherits the full environment tool surface. Orchestrator tools are always denied on resume.
- `subagent_status` tool returns a **live snapshot immediately on every call** — no rate limiting or throttling. Status changes are also auto-delivered as steers. Callers can poll as often as needed; each invocation recomputes state from `runningSubagents`.

## Work Guidance

- Prefer pure functions with explicit dependencies over module-level state
- New mux operations go in `mux.ts`, new layout logic goes in `mux-layout.ts` or `monocle.ts` for window-based monocle layout
- Resize backends go in `herdr-mux.ts` and `tmux-mux.ts` — dispatch through closures in `mux.ts:createSurface()`
- All config/agent resolution goes through `agent.ts` and `config.ts`
- **Sub-agent prompt minimization**: every sub-agent strips unnecessary layers (pi base prompt via `replace`, project context via `--no-context-files`, skills via `--no-skills`, orchestration via `PI_SUBAGENT_NAME` guard). Custom extensions are disabled — only `subagent-done.ts` is injected.
- **Status tool has no rate limiting**: `subagent_status` always returns a fresh live snapshot on each call. There is no minimum interval, no backoff, and no snapshot cache. The `status` config object only carries `enabled` and `lineLimit`.

## Verification

- Unit tests in `test/test.ts` cover: session.ts, status.ts, mux.ts, interrupt, renderers, widget, agent defaults, subagent-done, discovery, `subagent_status` live-snapshot behavior (immediate returns across repeated calls, no throttled flag), shared.ts export surface (throttle/backoff helpers removed), and config parsing (enabled, lineLimit, rejection of removed `minIntervalMs`)
- Run: `npm test`

## Child DOX Index

*(No child AGENTS.md files — this is a flat module directory.)*
