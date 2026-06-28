# Handoff — pi-my-subagents

## Session Context

This session completed the **multi-layout subagent pane system** for the `pi-my-subagents` pi-coding-agent extension. Two layouts are now fully implemented across both tmux and herdr backends.

## What Was Done

### Features implemented
- **Bottom-stack layout** (`layout: "bottom-stack"`): master area on top (70% height), sub-agent stack below (30% height, equal-width panes)
- **Tiling layout** (`layout: "tiling"`): master on left (70% width), sub-agent stack on right (30% width, equal-height panes) — DWM-style default
- **DEFAULT_SPLIT_RATIO = 0.30** shared constant for both layouts
- **Config schema**: `LayoutType = "tiling" | "bottom-stack"` in types.ts, `layout` field in `SubagentConfig`, merged via `loadSubagentConfig()`
- **Interactive menu**: `/subagent-config` now shows top-level category menu (Agents config / Layout config)
- **Layout-aware pane-closure fallback**: bottom-stack uses `down` split on reset, tiling uses `right`
- **Width equalize functions**: `tmuxResizeWidths`/`tmuxGetPaneWidth`, `herdrResizeWidths`/`herdrGetPaneWidth`

### Bug fixes
- **tmux inverted ratio**: `split-window -p` specifies **new pane's** size (not existing). Fixed `(1-ratio)*100` → `ratio*100`
- **herdr inverted ratio**: `pane split --ratio` specifies **existing pane's** share (not new pane's). Fixed `ratio` → `1-ratio`
- **Tiling ratio not applied**: `useFirstRatio` was only enabled for bottom-stack. Changed to always `true`

### Test coverage
8 tests in `test/mux-layout.test.ts`:
- 5 tiling tests (first split, equalize 2/3 panes, pane-closure, resetLayout)
- 3 bottom-stack tests (down split with ratio, second split equalize widths, pane-closure)

## Architecture

```
commands.ts → createSurface(name, layout?) → createTileSurface(name, ..., layoutMode)
  ├── "tiling":       splitFn(right, ratio=0.30) → subsequent splitFn(down)
  │                   → tmuxResizeStack / herdrResizeStack (height equalize)
  └── "bottom-stack": splitFn(down, ratio=0.30) → subsequent splitFn(right)
                      → tmuxResizeWidths / herdrResizeWidths (width equalize)
```

Key files in `pi-extension/subagents/`:
| File | Role |
|------|------|
| `mux-layout.ts` | Layout engine — `createTileSurface`, `equalizePanes`, `resetLayout`, `DEFAULT_SPLIT_RATIO` |
| `mux.ts` | Backend dispatch — `createSurface`, `createSurfaceSplit` (tmux/herdr routing) |
| `tmux-mux.ts` | tmux resize helpers (height + width) |
| `herdr-mux.ts` | herdr resize helpers (height + width) |
| `config.ts` | Config read/write/merge with `layout` field |
| `types.ts` | `LayoutType`, `SubagentConfig` types |
| `commands.ts` | `/subagent-config` slash command handler |
| `wizard.ts` | Interactive config wizard with category menu |

## Relevant Artifacts

- **PRD**: beads issue `pi-my-subagents-17w` (closed)
- **Implementation issues**: `pi-my-subagents-gs3`, `pi-my-subagents-bl5`, `pi-my-subagents-h4k` (all closed)
- **AGENTS.md docs**: `pi-extension/subagents/AGENTS.md` (updated with layout mode docs)
- **Tests**: `test/mux-layout.test.ts`

## Config Locations

- Project: `.pi/subagent-config.json`
- Global: `~/.pi/agent/subagent-config.json`

```json
{
  "layout": "tiling",
  "agents": {
    "worker": { "model": "...", "extensions": [...], "skills": [...] }
  }
}
```

## Suggested Skills

- **browser-search**: if next session needs to research tmux/herdr behavior for any future backend work
- **tdd**: when adding new layout modes or backend features — test seam is at `createTileSurface` with mocked `splitFn`/`resizeFn`/`getSizeFn`
- **write-a-skill**: if any reusable knowledge should be packaged as a skill
- **handoff**: to compact further sessions when context grows large

## Known State

- `package-lock.json` may show as modified locally (from `pi update --extensions` npm install) — safe to ignore/reset
- No open issues remain on beads tracker for this feature
- Extension registered command: `/subagent-config`
- Layout changes require `/reload` to take effect
