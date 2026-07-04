# pi-extension/subagents — Core Extension Module

## Purpose

The subagent extension for pi — spawn, orchestrate, and manage sub-agent sessions in tmux/herdr multiplexer panes. Fully non-blocking: main agent keeps working while subagents run in the background.

## Ownership

- **`mux.ts`** — tmux/herdr backend abstraction (createSurface, sendCommand, pollForExit, etc.)
- **`herdr-mux.ts`** — herdr backend resize functions. Height: herdrResizeStack, herdrGetPaneHeight. Width: herdrResizeWidths, herdrGetPaneWidth.
- **`tmux-mux.ts`** — tmux backend resize functions. Height: tmuxResizeStack, tmuxGetPaneHeight. Width: tmuxResizeWidths, tmuxGetPaneWidth.
- **`mux-layout.ts`** — layout engine for subagent panes (createTileSurface, equalizePanes, DEFAULT_SPLIT_RATIO). Supports tiling (DWM-style) and bottom-stack layouts via layoutMode parameter. State: lastSubagentSurface, stackPanes.
- **`monocle.ts`** — monocle layout engine for subagent panes (createMonocleSurface, equalizeMonoclePanes, resetMonocleLayout, getGroupName). First subagent of a type creates a new window; subsequent subagents of same type share that window with equalized heights. State: monocleState Map<string, MonocleGroup>.
- **`spawner.ts`** — launch + watch lifecycle (launchSubagent, watchSubagent)
- **`types.ts`** — core type definitions (SubagentParams, RunningSubagent, SubagentResult, etc.)
- **`status.ts`** — subagent status state machine (starting → active → waiting → stalled)
- **`activity.ts`** — subagent activity recording
- **`session.ts`** — session file management (read/write/merge)
- **`agent.ts`** — agent definition loading, defaults resolution, path resolution
- **`prompt-inject.ts`** — `before_agent_start` hook that appends available sub-agents to the system prompt
- **`interrupt.ts`** — interrupt/signal handling for running subagents
- **`renderers.ts`** — message renderers for result/status/ping/stalled
- **`subagent.ts`** — tool implementations (subagent, subagent_resume, subagent_interrupt)
- **`subagent-done.ts`** — subagent completion sidecar handler
- **`widget.ts`** — live widget rendering for the TUI
- **`config.ts`** — per-agent resource override config
- **`commands.ts`** — pi commands (subagent config)
- **`discovery.ts`** — discovery of agents, extensions, skills, and models
- **`test-slice.ts`** — exported test helpers

## Local Contracts

- `index.ts` is the extension entry point — registers tools, commands, message renderers, and widgets with pi
- All modules import from `./mux.ts` for multiplexer operations — never call tmux/herdr directly
- `mux-layout.ts` is consumed by `mux.ts:createSurface()` — external callers use `createSurface(name, layout?)` only. Layout can be "tiling" (default) or "bottom-stack". Falls back to config file if not passed explicitly.
- `spawner.ts` exports `launchSubagent()` and `watchSubagent()` — lifecycle is: launch → poll for exit → close surface
- Status transitions go through `status.ts:advanceStatusState()` — never mutate statusState directly

## Work Guidance

- Prefer pure functions with explicit dependencies over module-level state
- New mux operations go in `mux.ts`, new layout logic goes in `mux-layout.ts` or `monocle.ts` for window-based monocle layout
- resize backends go in `herdr-mux.ts` and `tmux-mux.ts` — dispatch through closures in `mux.ts:createSurface()`
- All config/agent resolution goes through `agent.ts` and `config.ts`

## Verification

- Unit tests in `test/test.ts` cover: session.ts, status.ts, mux.ts, interrupt, renderers, widget, agent defaults, subagent-done, discovery
- Run: `npm test`

## Child DOX Index

*(No child AGENTS.md files — this is a flat module directory.)*
