# Implementation Plan: pi-my-subagent

Fork of `pi-interactive-subagents` (HazAT). Buang Claude Code + cmux/zellij/wezterm. Tambah herdr backend. Cuma tmux & herdr.

## Step 1: Create directory structure

```bash
PROJ=/home/djs/.pi/agent/plugthenplay/pi-my-subagent
ORIG=/home/djs/.pi/agent/plugthenplay/pi-interactive-subagents

mkdir -p $PROJ/agents
mkdir -p $PROJ/pi-extension/subagents
mkdir -p $PROJ/test
mkdir -p $PROJ/.pi
```

## Step 2: Copy unchanged files

Copy these files AS-IS from original:

- `$ORIG/session.ts` → `$PROJ/pi-extension/subagents/session.ts`
- `$ORIG/activity.ts` → `$PROJ/pi-extension/subagents/activity.ts`
- `$ORIG/subagent-done.ts` → `$PROJ/pi-extension/subagents/subagent-done.ts`
- `$ORIG/test/test.ts` → `$PROJ/test/test.ts`
- `$ORIG/test/system-prompt-mode.test.ts` → `$PROJ/test/system-prompt-mode.test.ts`
- `$ORIG/LICENSE` → `$PROJ/LICENSE`
- `$ORIG/.gitignore` → `$PROJ/.gitignore`
- `$ORIG/.pi/settings.json` → `$PROJ/.pi/settings.json`
- `$ORIG/config.json.example` → `$PROJ/config.json.example`
- `$ORIG/agents/planner.md` → `$PROJ/agents/planner.md`
- `$ORIG/agents/scout.md` → `$PROJ/agents/scout.md`
- `$ORIG/agents/worker.md` → `$PROJ/agents/worker.md`
- `$ORIG/agents/reviewer.md` → `$PROJ/agents/reviewer.md`
- `$ORIG/agents/visual-tester.md` → `$PROJ/agents/visual-tester.md`
- `$ORIG/pi-extension/subagents/subagent-done.ts` → `$PROJ/pi-extension/subagents/subagent-done.ts`
- `$ORIG/pi-extension/subagents/plan-skill.md` → `$PROJ/pi-extension/subagents/plan-skill.md`

## Step 3: Create package.json

File: `$PROJ/package.json`

```json
{
  "name": "pi-my-subagent",
  "version": "1.0.0",
  "description": "Async subagents for pi - spawn, orchestrate, and manage sub-agent sessions in tmux/herdr terminals",
  "keywords": ["pi-package"],
  "license": "MIT",
  "author": "",
  "type": "module",
  "scripts": {
    "test": "node --test test/test.ts"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": "*",
    "@mariozechner/pi-tui": "*",
    "@sinclair/typebox": "*"
  },
  "pi": {
    "extensions": ["./pi-extension/subagents/index.ts"]
  }
}
```

## Step 4: Create mux.ts (TMUX + HERDR only)

File: `$PROJ/pi-extension/subagents/mux.ts`

Based on original `$ORIG/pi-extension/subagents/cmux.ts`.

### What to REMOVE from cmux.ts:
- Remove ALL cmux-specific code: `cmuxSubagentPane`, `CmuxFocusSnapshot`, `CmuxCreatedSurface`, `CmuxIdentifySnapshot`, `parseCmuxFocusedSnapshot`, `parseCmuxJson`, `parseCmuxCallerSnapshot`, `parseCmuxPaneRefForSurface`, `readCmux`, `parseCmuxIdentifySnapshot`, `captureCmuxIdentifySnapshot`, `captureCmuxFocusSnapshot`, `readCmuxPaneRefForSurface`, `restoreCmuxFocusSnapshot`, `waitForCmuxFocusSettle`, `cmuxFocusMatchesChild`, `cmuxFocusMatchesSurfaceRef`, `cmuxFocusMatchesPaneRef`, `restoreCmuxFocusIfLaunchSurfaceFocused`, `parseCmuxCreatedSurface`, `renameCmuxSurface`, `createCmuxSplitSurface`, `createSurfaceInPane`
- Remove ALL zellij-specific code: `ZellijPaneSnapshot`, `ZellijSplitDirection`, `ZellijPlacementPlan`, `paneArea`, `isUsableZellijTiledPane`, `predictZellijSplitDirection`, `canSplitZellijPane`, `zellijTabPanesForParent`, `selectZellijStackPlacement`, `selectZellijPlacement`, `parseZellijPaneSurface`, `readZellijPanes`, `createZellijTiledPane`, `createZellijStackedPane`, `createZellijTab`, `zellijSurfaceLockPath`, `withZellijSurfaceLock`, `createZellijSurfaceUnlocked`, `createZellijSurface`, `zellijPaneId`, `zellijEnv`, `ZELLIJ_PANE_SCOPED_ACTIONS`, `zellijActionArgs`, `zellijActionSync`, `zellijActionAsync`, `ZELLIJ_MIN_TERMINAL_WIDTH`, `ZELLIJ_MIN_TERMINAL_HEIGHT`, `ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO`, `DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS`, `DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS`
- Remove ALL wezterm-specific code (WezTerm sections in every function)
- Remove `plugin/` reference (line with `join(SUBAGENTS_DIR, "plugin")`)
- Export type: `type MuxBackend = "herdr" | "tmux";`
- `PollResult.reason` type: keep `"sentinel"` (it's still returned by terminal screen poll fallback). Type stays `"done" | "ping" | "sentinel" | "error"`.
- Remove `sendLongCommand` function signature changes (keep it, just drop wezterm/zellij/cmuix branches)

### What to KEEP from cmux.ts:
- `hasCommand()`, `shellEscape()`, `tailLines()`, `isFishShell()`, `exitStatusVar()`
- Tmux backend in all functions (sendCommand, sendEscape, sendLongCommand, readScreen, readScreenAsync, closeSurface, renameCurrentTab, renameWorkspace, createSurface, createSurfaceSplit)
- `pollForExit()` remove sentinel check, keep exit sidecar + screen sentinel
- `interpretExitSidecar()`

### What to ADD (herdr backend):

```typescript
function isHerdrRuntimeAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}
```

Detection priority:
```typescript
export function getMuxBackend(): MuxBackend | null {
  if (isHerdrRuntimeAvailable()) return "herdr";
  if (isTmuxRuntimeAvailable()) return "tmux";
  return null;
}
```

#### herdr backend implementation in each function:

**createSurface(name)**:
```typescript
// herdr
const currentPane = process.env.HERDR_PANE_ID;
if (!currentPane) throw new Error("HERDR_PANE_ID not set");
const result = execFileSync("herdr", ["pane", "split", currentPane, "--direction", "right", "--no-focus"], { encoding: "utf8" });
const parsed = JSON.parse(result);
const paneId = parsed?.result?.pane?.pane_id;
if (!paneId) throw new Error("Failed to parse herdr pane id");
return paneId;
```

**sendCommand(surface, command)**:
```typescript
// herdr
execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
return;
```

**sendEscape(surface)**:
```typescript
// herdr
execFileSync("herdr", ["pane", "send-keys", surface, "Escape"], { encoding: "utf8" });
return;
```

**sendLongCommand(surface, command, options?)**:
Write script file, then:
```typescript
// herdr
execFileSync("herdr", ["pane", "run", surface, "bash " + shellEscape(scriptPath)], { encoding: "utf8" });
return scriptPath;
```

**readScreen(surface, lines = 50)**:
```typescript
// herdr
const raw = execFileSync("herdr", ["pane", "read", surface, "--source", "recent", "--lines", String(lines)], { encoding: "utf8" });
return raw;
```

**readScreenAsync(surface, lines = 50)**:
```typescript
// herdr
const { stdout } = await execFileAsync("herdr", ["pane", "read", surface, "--source", "recent", "--lines", String(lines)], { encoding: "utf8" });
return stdout;
```

**closeSurface(surface)**:
```typescript
// herdr
execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
return;
```

**renameCurrentTab(title)**:
```typescript
// herdr
const tabId = process.env.HERDR_TAB_ID;
if (tabId) {
  execFileSync("herdr", ["tab", "rename", tabId, title], { encoding: "utf8" });
}
return;
```

**renameWorkspace(title)**:
```typescript
// herdr
const wsId = process.env.HERDR_WORKSPACE_ID;
if (wsId) {
  const wsNumber = wsId.replace(/^w/, "");
  execFileSync("herdr", ["workspace", "rename", wsNumber, title], { encoding: "utf8" });
}
return;
```

**Note on herdr renameWorkspace:** The `HERDR_WORKSPACE_ID` env var format (`w4`) is undocumented herdr internal format. Currently confirmed to work with `replace(/^w/, "")` to get the numeric workspace ID. Consider guarding with `PI_SUBAGENT_RENAME_HERDR_WORKSPACE` env var for parity with tmux's `PI_SUBAGENT_RENAME_TMUX_SESSION`.

### pollForExit changes:
- Remove the sentinel FILE check (Claude-specific) — the `sentinelFile` option
- Keep the terminal screen `__SUBAGENT_DONE_(\d+)__` sentinel fallback (used by both backends for crash detection)
- Keep the `.exit` sidecar fast path (subagent_done / caller_ping)
- Remove `sentinelFile` from the options interface

### isMuxAvailable / muxSetupHint:
```typescript
export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or herdr.";
}
```

### Exported items:
Export all the same functions as original: `isMuxAvailable`, `muxSetupHint`, `createSurface`, `createSurfaceSplit`, `sendCommand`, `sendEscape`, `sendLongCommand`, `readScreen`, `readScreenAsync`, `closeSurface`, `getMuxBackend`, `shellEscape`, `renameCurrentTab`, `renameWorkspace`, `PollResult`, plus test exports.

## Step 5: Create status.ts (PI only)

File: `$PROJ/pi-extension/subagents/status.ts`

Based on original `$ORIG/pi-extension/subagents/status.ts`.

### Changes:
1. Remove `"claude"` from `SubagentStatusSource` — it's just `"pi"` now
2. Remove `"running"` from `SubagentStatusKind` — only `"starting" | "active" | "waiting" | "stalled"`
3. In `createStatusState()`: initial kind is always `"starting"` (remove claude source check)
4. In `observeStatus()`: remove `if (state.source === "claude") return state;` guard
5. In `classifyStatus()`: remove the `if (state.source === "claude") { return { kind: "running", ... }; }` block entirely
6. In `forceStatusAfterInterrupt()`: remove `if (state.source === "claude") return state;`
7. Keep everything else unchanged

## Step 6: Create index.ts (PI only, no Claude)

File: `$PROJ/pi-extension/subagents/index.ts`

Based on original `$ORIG/pi-extension/subagents/index.ts`.

### Changes:

**Imports:**
- Keep: all cmux.ts imports → change to `./mux.ts`
- Remove: `copyFileSync, unlinkSync` from fs (only claude-specific code)
- KEEP: `readdirSync` — it's used by `discoverAgentDefinitions()`
- Remove: plugin import references

**SubagentParams Type:**
- Remove `resumeSessionId` parameter (Claude-specific)

**Type definitions:**
- Remove `"sentinel"` from poll exit reason types
- `SubagentResult`: remove `claudeSessionId` field, remove `errorMessage` if Claude-specific
- `RunningSubagent`: remove `cli?: string`, `sentinelFile?: string`, remove claude init from `statusState`

**`launchSubagent()`:**
- Remove entire `if (agentDefs?.cli === "claude") { ... }` block
- Remove sentinel/plugin directory checks

**`watchSubagent()`:**
- Remove `if (running.cli === "claude") { ... }` block
- Remove `copyClaudeSession()` function
- Simplify result extraction to pi-only path

**`pollForExit`:**
- Remove `sentinelFile` parameter handling
- Keep the `.exit` sidecar fast path and terminal sentinel slow path

**`copyClaudeSession()`**: Remove entirely

**`handleSubagentInterrupt()`:**
- Remove claude-specific check (`if (running.cli === "claude")`)

**`observeRunningSubagent()`:**
- Remove `if (running.cli === "claude") return;` guard

**Widget/Status:**
- `formatWidgetRightLabel()`: remove `"running"` snapshot kind handling
- Status-related code: pi-only

**Tests export (`__test__`):**
- Remove claude-related test helpers

## Step 7: Create README.md

Rewrite to cover pi-only, tmux/herdr only. Follow the original structure but:
- Only mention pi (not Claude Code)
- Only mention tmux + herdr as multiplexers
- Update install instructions for tmux/herdr
- Remove claude-related agent docs

## Step X: Fix test file

File: `$PROJ/test/test.ts`

This file is copied from original but needs modification because it imports cmux/zellij/wezterm functions that no longer exist.

### Fix imports:
Change the import block from cmux.ts:
```typescript
import {
  shellEscape,
  isCmuxAvailable,
  isWezTermAvailable,
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  canSplitZellijPane,
  predictZellijSplitDirection,
  selectZellijPlacement,
  selectZellijStackPlacement,
} from "../pi-extension/subagents/cmux.ts";
```

To (mux.ts, only keep shellEscape + interpretExitSidecar):
```typescript
import {
  shellEscape,
} from "../pi-extension/subagents/mux.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/mux.ts";
```

### Remove these describe blocks:
1. `describe("cmux.ts", {` block starting at line 2088 — remove entirely (it contains parseCmux*, zellij placement, isCmuxAvailable, isWezTermAvailable tests)
2. Also remove the now-unused imports at the top: `isCmuxAvailable`, `isWezTermAvailable`, `parseCmuxFocusedSnapshot`, `parseCmuxFocusedSnapshotFromJson`, `parseCmuxJson`, `parseCmuxPaneRefForSurface`, `parseCmuxPaneRefForSurfaceFromJson`, `canSplitZellijPane`, `predictZellijSplitDirection`, `selectZellijPlacement`, `selectZellijStackPlacement`

### Fix the describe("cmux.ts interpretExitSidecar") block:
Rename `describe("cmux.ts interpretExitSidecar")` to `describe("mux.ts interpretExitSidecar")`.

### Fix __pollForExitTest__ import path:
Change `from "../pi-extension/subagents/cmux.ts"` to `from "../pi-extension/subagents/mux.ts"`

## Step 8: Remove unused files

- Remove `$PROJ/agents/claude-code.md` (don't copy it)
- Remove `$PROJ/pi-extension/subagents/plugin/` directory (don't copy it)
- Don't copy test/integration/ (those need cmux/zellij)

## Execution order

1. Step 1: mkdir
2. Step 2: Copy unchanged files
3. Step 3: Write package.json
4. Step 4: Write mux.ts
5. Step 5: Write status.ts
6. Step 6: Write index.ts
7. Step 7: Write README.md
8. Step 8: Verify structure
