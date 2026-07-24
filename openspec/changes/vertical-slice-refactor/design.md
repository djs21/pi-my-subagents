## Context

The subagents extension (`pi-extension/subagents/`) has 24 flat `.ts` files. The three most active — `agent.ts` (350 lines), `spawner.ts` (320 lines), `subagent.ts` (368 lines) — have mixed responsibilities:

- **`agent.ts`** contains config parsing, agent loading, path resolution, AND all enforcement config building (tools, deny, model, skills). Four distinct concerns in one file.
- **`spawner.ts`** contains BOTH enforcement assembly (load agent → build tools/deny/model → assemble CLI flags) AND the launch lifecycle (mux surface → shell readiness → send command). The `watchSubagent()` function is shared but lives here.
- **`subagent.ts`** contains two tool handlers (spawn + resume) that SHOULD share enforcement logic but DON'T — `executeSubagentTool()` delegates to `launchSubagent()` in spawner.ts, while `executeSubagentResume()` builds its own command directly, bypassing ALL enforcement.

This design replaces three horizontal files with four vertical slices, each owning a complete concern. The existing tests in `test-slice.ts` and all imports in `index.ts` are updated accordingly.

## Goals / Non-Goals

**Goals:**
- Each module has one clear responsibility and is independently understandable
- `resume.ts` uses `enforce.ts` for tool/model/deny enforcement (fixes P1)
- Scout/reviewer/visual-tester tool mismatches fixed (P2/P3/P7)
- No circular imports (`agent.ts` does not import from any new module)
- Duplicate surface-readiness code eliminated (~30 lines extracted to shared helper)
- Zero external behavior changes — all tool names, config formats, and agent interfaces identical

**Non-Goals:**
- No new features — this is pure restructuring
- No runtime behavior changes beyond the P1/P2/P3/P7 fixes
- No test additions — existing tests must still pass with updated imports
- No changes to `types.ts`, `mux.ts`, `session.ts`, `config.ts`, `activity.ts`, `status.ts`, `widget.ts`, `interrupt.ts`, `renderers.ts`, `discovery.ts`, `commands.ts`, `wizard.ts`, `prompt-inject.ts`, `subagent-done.ts`, layout engines, or mux backends

## Decisions

### Decision 1: enforce.ts is a shared config builder, not a full lifecycle module

**Why:** Enforcement logic is pure configuration — it takes agent definitions and returns CLI flags and env vars. It has no I/O (except reading agent .md files via `loadAgentDefaults`), no mux, no lifecycle. Keeping it pure prevents it from becoming a dumping ground.

**Imports:** `enforce.ts` → `agent.ts`, `types.ts`, `config.ts` only. Does NOT import from `spin.ts`, `resume.ts`, `shared.ts`, or `mux.ts`.

**Functions transferred from `agent.ts`:**
- `resolveDenyTools()` → enforce.ts
- `buildSubagentToolAllowlist()` → enforce.ts
- `buildPiPromptArgs()` → enforce.ts
- `resolveLaunchBehavior()`, `resolveEffectiveInteractive()`, `resolveEffectiveSessionMode()` → enforce.ts
- `resolveResumeLaunchBehavior()` → resume.ts (it's resume-specific)

**`buildAgentResourceArgs()` STAYS in agent.ts** — it calls `shellEscape()` from mux.ts and the private `scanSkillDir()`. Moving it would break enforce.ts's import rule (no mux) or require exporting a private. Both spin.ts and resume.ts import `buildAgentResourceArgs` from agent.ts instead.

### Decision 2: shared.ts owns cross-cutting lifecycle infra

**Why:** `watchSubagent()` is called by both spawn and resume flows. `runningSubagents` singleton is accessed from multiple files. The surface-readiness polling block (~30 lines) is identically duplicated in `launchSubagent()` and `executeSubagentResume()`. These belong in a shared infra module, not in either slice.

**Contents of shared.ts:**
- `surfaceReadiness()` — extracted duplicate block for shell readiness polling
- `watchSubagent()` — moved from spawner.ts as-is
- `getModuleAbortSignal()` — moved from spawner.ts (called by watchSubagent)
- `runningSubagents` — singleton Map, moved from spawner.ts
- `updateWidget()`, `startWidgetRefresh()`, `setLatestCtx()`, `latestCtx` — moved from subagent.ts (widget wrappers used by spin, resume, and index.ts)
- Activity file and launch script helpers (small utility functions)

**Imports:** `shared.ts` → `mux.ts`, `session.ts`, `types.ts`, `activity.ts`, `status.ts`. Does NOT import from `enforce.ts`, `agent.ts`, `spin.ts`, or `resume.ts` — this guarantees no cycle.

### Decision 3: spin.ts owns the complete spawn lifecycle

**Why:** Spawning a new sub-agent is a self-contained flow: load config → create surface → seed session → build command → launch → watch. All of this lives in one file.

**Contents of spin.ts:**
- `launchSubagent()` — from spawner.ts, minus surfaceReadiness (shared) and watch logic (shared)
- `executeSubagentTool()` — from subagent.ts
- `createSubagentTool()` — from subagent.ts
- `renderSubagentCall()` — from subagent.ts
- `renderSubagentResult()` — from subagent.ts

**Imports:** `spin.ts` → `enforce.ts` (config), `shared.ts` (surfaceReadiness, watchSubagent), `agent.ts` (path resolution), `mux.ts` (surface creation), `session.ts` (seed), `types.ts`.

### Decision 4: resume.ts owns the complete resume lifecycle AND enforcement

**Why:** Resume currently bypasses all enforcement. By giving resume its own file with the same contract as spin (call enforce.ts), we fix P1 without coupling the two flows.

**Contents of resume.ts:**
- `executeSubagentResume()` — from subagent.ts, now calls enforce.ts for `--tools`, `PI_DENY_TOOLS`, `PI_SUBAGENT_AGENT`
- `createSubagentResumeTool()` — from subagent.ts, adds optional `agent` parameter
- `renderSubagentResumeCall()` — from subagent.ts
- `renderSubagentResumeResult()` — from subagent.ts
- `resolveResumeLaunchBehavior()` — from agent.ts (resume-specific utility)

**Imports:** `resume.ts` → `enforce.ts` (config), `shared.ts` (surfaceReadiness, watchSubagent, runningSubagents), `agent.ts` (loadAgentDefaults, path utils), `mux.ts`, `session.ts`, `types.ts`.

### Decision 5: agent.ts keeps parsing, loading, paths, and utilities

**Why:** `parseAgentDefinition()`, `loadAgentDefaults()`, `resolveAgentByPrefix()`, `discoverAgentDefinitions()`, `resolveSubagentPaths()`, `getDefaultSessionDirFor()`, `getArtifactDir()` all deal with reading and resolving agent configuration files. This is a coherent concern that `enforce.ts` and `spin.ts/resume.ts` depend on. Keeping them in `agent.ts` and ensuring `agent.ts` imports FROM nothing new guarantees no circular imports.

**Functions that STAY in agent.ts:**
- `getBundledAgentsDir()`, `getAgentConfigDir()` — path constants
- `parseAgentDefinition()`, `getFrontmatterValue()`, `parseOptionalBoolean()`, `parseSessionMode()` — config parsing
- `loadAgentDefaults()`, `resolveAgentByPrefix()`, `discoverAgentDefinitions()` — agent loading
- `resolveSubagentPaths()`, `getDefaultSessionDirFor()`, `getArtifactDir()` — path resolution
- `formatElapsed()`, `getShellReadyDelayMs()`, `muxUnavailableResult()`, `activityLabel()` — utilities

### Decision 6: Scout/reviewer get `write` in frontmatter AND body drops `edit`; visual-tester body drops `edit`

**Why:** Scout and reviewer NEED write to deliver reports. Adding `write` to their frontmatter `tools:` aligns actual capability with body instructions. Their `edit` tool listing in the body is dropped — they don't need it and the frontmatter doesn't grant it. Visual-tester same pattern: no `edit` in body (and frontmatter never had it). Frontmatter and body tool lists MUST match.

**Why:** Scout and reviewer NEED write to deliver reports. Adding `write` to their frontmatter `tools:` list aligns actual capability with body instructions. Visual-tester doesn't need `edit` — removing it from the body tool list keeps frontmatter and body consistent without granting unnecessary capability.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| **Circular import** between enforce.ts and agent.ts | `enforce.ts` imports from `agent.ts` (loadAgentDefaults), but `agent.ts` does NOT import from `enforce.ts`, `shared.ts`, `spin.ts`, or `resume.ts`. All imports flow one direction: `spin.ts/resume.ts → enforce.ts → agent.ts` and `spin.ts/resume.ts → shared.ts → mux.ts/session.ts`. Architecturally enforced. |
| **Import graph drift** — someone adds cross-slice import later | Key contract: `enforce.ts` never imports from spin/resume/shared. `shared.ts` never imports from enforce/agent/spin/resume. `agent.ts` never imports from enforce/spin/resume/shared. |
| **RunningSubagents singleton still global mutable state** | Moving it to `shared.ts` doesn't change its nature, but makes the dependency explicit. Future improvement could wrap it in an accessor pattern, but that's out of scope here. |
| **test-slice.ts imports break** | All imports in `test-slice.ts` reference `spawner.ts` and `subagent.ts` which are REMOVED. Must update to reference `spin.ts`, `resume.ts`, and `shared.ts`. |
| **Git blame noise from code moves** | Acceptable — the restructuring is a one-time cost. Using `git mv`-equivalent file creation + deletion preserves some history. |

## Migration Plan

*Tasks 1-4 create new files independently — can be parallelized. Task 9 (frontmatter fixes) is also independent and can be done anytime.*

1. Create `enforce.ts` — extract `buildSubagentToolAllowlist`, `resolveDenyTools`, `buildPiPromptArgs`, `resolveLaunchBehavior`, `resolveEffectiveInteractive`, `resolveEffectiveSessionMode` from `agent.ts`. **`buildAgentResourceArgs` stays in agent.ts** (needs mux.ts's shellEscape).
2. Create `shared.ts` — extract `watchSubagent()`, `runningSubagents`, `surfaceReadiness`, `getModuleAbortSignal` from `spawner.ts`; `updateWidget()`, `startWidgetRefresh()`, `setLatestCtx()`, `latestCtx` from `subagent.ts`
3. Create `spin.ts` — copy `launchSubagent()` from `spawner.ts`, update imports (use enforce.ts, shared.ts)
4. Create `resume.ts` — copy `executeSubagentResume()` + renderers + tool factory from `subagent.ts`, add enforce.ts calls, add `agent` param to tool definition; import `resolveResumeLaunchBehavior` from agent.ts
5. Update `agent.ts` — remove enforcement functions moved to enforce.ts (keep `buildAgentResourceArgs`, `resolveResumeLaunchBehavior` moved to resume.ts)
6. Update `index.ts` — change imports from spawner.ts/subagent.ts to spin.ts/resume.ts/shared.ts
7. Update `test-slice.ts` — change imports to new modules
8. Delete `spawner.ts` — all content moved to spin.ts + shared.ts
9. Delete `subagent.ts` — all content moved to spin.ts + resume.ts
10. Fix P2/P3: update `agents/scout.md` and `agents/reviewer.md` — frontmatter `tools:` to `read, bash, write`, body drops `edit` from "Available tools"
11. Fix P7: update `agents/visual-tester.md` body — remove `edit` from "Available tools" section
12. Verify no circular imports and all tests pass
