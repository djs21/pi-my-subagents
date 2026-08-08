# pi-extension/subagents — Core Extension Module

## Purpose

The subagent extension for pi — spawn, orchestrate, and manage sub-agent sessions in tmux/herdr multiplexer panes. Fully non-blocking: main agent keeps working while subagents run in the background.

## Ownership

- **`mux.ts`** — tmux/herdr backend abstraction (createSurface, sendCommand, pollForExit, etc.)
- **`herdr-mux.ts`** — herdr backend resize functions. Height: herdrResizeStack, herdrGetPaneHeight. Width: herdrResizeWidths, herdrGetPaneWidth.
- **`tmux-mux.ts`** — tmux backend resize functions. Height: tmuxResizeStack, tmuxGetPaneHeight. Width: tmuxResizeWidths, tmuxGetPaneWidth.
- **`mux-layout.ts`** — layout engine for subagent panes (createTileSurface, equalizePanes, DEFAULT_SPLIT_RATIO). Supports tiling (DWM-style) and bottom-stack layouts via layoutMode parameter. State: lastSubagentSurface, stackPanes.
- **`monocle.ts`** — monocle layout engine for subagent panes (createMonocleSurface, equalizeMonoclePanes, resetMonocleLayout, getGroupName). First subagent of a type creates a new window; subsequent subagents of same type share that window with equalized heights. State: monocleState Map<string, MonocleGroup>.
- **`enforce.ts`** — enforcement config builder (buildSubagentToolAllowlist, resolveDenyTools, buildPiPromptArgs, resolveLaunchBehavior, resolveEffectiveInteractive, resolveEffectiveSessionMode). Pure config, no mux/I/O.
- **`shared.ts`** — shared lifecycle infra (surfaceReadiness, watchSubagent, runningSubagents, getModuleAbortSignal, updateWidget, startWidgetRefresh, setLatestCtx, lastStatusCheckAt, throttleStrikes, effectiveInterval, resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleRemainingMs, getStatusThrottleStrikes, setStatusSnapshot, getStatusSnapshot, getCoordDir, writeIncomingMessage, countPendingFiles, MAX_MESSAGE_CHARS, MAX_MESSAGES_PER_CALL, MAX_PENDING_FILES). Coordination helpers (getCoordDir, writeIncomingMessage, countPendingFiles) provide single source of truth for inter-agent messaging. Constants define message limits (4000 chars, 10 messages per call, 10 pending files). Used by both spin and resume. Throttle state (including backoff strikes), snapshot cache are module-level (per-process, per-session). Backoff doubles cooldown per strike, capped at 8x base.
- **`spin.ts`** — spawn lifecycle (launchSubagent, executeSubagentTool, createSubagentTool, renderSubagentCall/Result). Owns the complete new-sub-agent flow.
- **`resume.ts`** — resume lifecycle (executeSubagentResume, createSubagentResumeTool, renderSubagentResumeCall/Result, resolveResumeLaunchBehavior). Fixes P1: enforces tools/deny/agent via enforce.ts.
- **`types.ts`** — core type definitions (SubagentParams, RunningSubagent, SubagentResult, etc.)
- **`status.ts`** — subagent status state machine (starting → active → waiting → stalled) + config parsing (StatusConfig with minIntervalMs, env override PI_SUBAGENT_STATUS_MIN_INTERVAL_MS, min-bound validation)
- **`activity.ts`** — subagent activity recording
- **`session.ts`** — session file management (read/write/merge)
- **`agent.ts`** — agent definition loading, defaults resolution, path resolution, config parsing
- **Tool/skill/extension override = append**: subagent-config.json `tools`/`skills`/`extensions` are ADDED to the agent .md base list (deduped), never replace it. Wizard "Available" list shows only tools not already effective.
- **`prompt-inject.ts`** — `before_agent_start` hook that appends available sub-agents to the system prompt
- **`interrupt.ts`** — interrupt/signal handling for running subagents
- **`renderers.ts`** — message renderers for result/status/ping/stalled
- **`subagent-done.ts`** — subagent completion sidecar handler + inter-agent communication (check_messages tool)
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
- **Fallback ke worker**: ketika exact match AND prefix match gagal, sub-agent mendapat agent defaults `worker` utuh (tools: read,bash,write,edit, model: claude-sonnet-4-6, auto-exit, worker system prompt). Safety net `read,bash` di `buildSubagentToolAllowlist()` tetap ada untuk path lain yang tidak lewat spin.ts.
- `prompt-inject.ts` guards orchestration notice via `PI_SUBAGENT_NAME` — only injects `<!-- subagent-orch-start -->` for the main agent, NOT sub-agents
- Agent `.md` files use `system-prompt: replace` (was `append`). The agent body IS the complete system prompt — must embed tool definitions and usage guidelines
- Skills can be added per agent via `skill:` frontmatter in `.md`, or via `agents.<name>.skills` in `subagent-config.json`. Skills are injected as `/skill:name` prompt args. Custom extensions from frontmatter or config are NOT loaded — only `subagent-done.ts` is injected as the mandatory extension.
- `spin.ts` creates coordination dir via `getCoordDir(id)` (single source of truth), sets PI_SUBAGENT_COORD_DIR env var
- `subagent-done.ts` registers `check_messages()` tool that reads & deletes .txt files from coord dir's incoming/ — provides non-blocking orchestrator → sub-agent messaging
- Status transitions go through `status.ts:advanceStatusState()` — never mutate statusState directly
- `resume.ts` creates coordination dir via `getCoordDir(id)` and sets `PI_SUBAGENT_COORD_DIR` env var (mirrors spin.ts)
- `send_messages` tool writes timestamped `.txt` files to target subagent's `incoming/` directory with all-or-nothing validation (empty array, too many, too long, whitespace-only, backpressure)
- `send_messages` resolves by `id` (preferred) or `name` against `runningSubagents` — id wins when both provided (matches interrupt.ts convention)
- `subagent_status` tool is rate-limited via `shared.ts:checkStatusThrottle()` — min 30s between calls (configurable) with **exponential backoff** (doubles per consecutive throttled call, capped at 8x base). `lastStatusCheckAt` is updated on both pass and throttle paths — each retry restarts the penalty clock. Throttle resets on new spawn via `resetStatusCheckThrottle()` in `spin.ts:launchSubagent`. Throttled responses include `throttled: true` in details, retry time, last-known status snapshot, and penalty text ("Repeated polling extends the cooldown."). Renderer checks `details.throttled` flag to distinguish throttled from genuinely-empty.

## Work Guidance

- Prefer pure functions with explicit dependencies over module-level state
- New mux operations go in `mux.ts`, new layout logic goes in `mux-layout.ts` or `monocle.ts` for window-based monocle layout
- Resize backends go in `herdr-mux.ts` and `tmux-mux.ts` — dispatch through closures in `mux.ts:createSurface()`
- All config/agent resolution goes through `agent.ts` and `config.ts`
- **Sub-agent prompt minimization**: every sub-agent strips unnecessary layers (pi base prompt via `replace`, project context via `--no-context-files`, skills via `--no-skills`, orchestration via `PI_SUBAGENT_NAME` guard). Custom extensions are disabled — only `subagent-done.ts` is injected.
- **Status tool rate limiting**: `subagent_status` enforces a minimum interval (default 30s, configurable via `status.minIntervalMs` or `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS`). Throttled calls return a short notice. Throttle resets on new spawn. This prevents the main agent from polling excessively and wasting API tokens.

## Verification

- Unit tests in `test/test.ts` cover: session.ts, status.ts, mux.ts, interrupt, renderers, widget, agent defaults, subagent-done, discovery, status throttle (checkStatusThrottle, resetStatusCheckThrottle) + getStatusThrottleRemainingMs, setStatusSnapshot/getStatusSnapshot, throttle response rendering (throttled flag, retry time, last-known status), getStatusThrottleStrikes, backoff (effectiveInterval, throttleStrikes, MAX_THROTTLE_STRIKES=3), config parsing (minIntervalMs default/env/config/min-bound)
- Run: `npm test`

## Child DOX Index

*(No child AGENTS.md files — this is a flat module directory.)*
