# Tasks — Vertical Slice Refactor

*Ordering note: Tasks 1-4 create new independent files and can be parallelized. Task 9 (frontmatter fixes) is also independent and can be done anytime. Hard deps: 5 depends on 1, 6-7 depend on 1-4, 8 depends on all prior, 10 depends on everything.*
## 1. Create enforce.ts (extract enforcement functions from agent.ts)

- [x] 1.1 Create `pi-extension/subagents/enforce.ts` exporting `buildSubagentToolAllowlist`, `resolveDenyTools`, `buildPiPromptArgs`, `resolveLaunchBehavior`, `resolveEffectiveInteractive`, `resolveEffectiveSessionMode` — copied verbatim from `agent.ts` with unchanged signatures and logic. **`buildAgentResourceArgs` stays in agent.ts** (needs mux.ts's shellEscape and private scanSkillDir).
- [x] 1.2 Add imports in enforce.ts: `loadAgentDefaults` from `./agent.ts`, types from `./types.ts`, config from `./config.ts` — verify enforce.ts does NOT import from `./spin.ts`, `./resume.ts`, or `./shared.ts`

## 2. Create shared.ts (extract watchSubagent, runningSubagents, surfaceReadiness from spawner.ts)

- [x] 2.1 Create `pi-extension/subagents/shared.ts` exporting `runningSubagents` singleton (Map), `watchSubagent()` function, `getModuleAbortSignal()` accessor — copied verbatim from `spawner.ts`. Also move `updateWidget()`, `startWidgetRefresh()`, `setLatestCtx()`, and the `latestCtx` module-level variable from `subagent.ts` (widget wrappers used by spin, resume, and index.ts).
- [x] 2.2 Extract the duplicate surface-readiness polling block (~30 lines currently in both `launchSubagent()` and `executeSubagentResume()`) into a `surfaceReadiness()` helper function in shared.ts, and add activity file / launch script helpers
- [x] 2.3 Verify shared.ts imports only from `./mux.ts`, `./session.ts`, `./types.ts`, `./activity.ts`, `./status.ts` — NOT from `./enforce.ts`, `./agent.ts`, `./spin.ts`, or `./resume.ts`

## 3. Create spin.ts (from spawner.ts + subagent.ts spawn parts)

- [x] 3.1 Create `pi-extension/subagents/spin.ts` containing `launchSubagent()` (from spawner.ts, refactored to call `surfaceReadiness` from shared.ts and enforcement from enforce.ts), `executeSubagentTool()` (from subagent.ts), `createSubagentTool()` (from subagent.ts), `renderSubagentCall()` (from subagent.ts), and `renderSubagentResult()` (from subagent.ts)
- [x] 3.2 Wire imports: spin.ts imports enforcement functions from `./enforce.ts`, surfaceReadiness/watchSubagent from `./shared.ts`, path/loading utils from `./agent.ts`, mux/session/types from their modules

## 4. Create resume.ts (from subagent.ts resume parts + enforcement fix)

- [x] 4.1 Create `pi-extension/subagents/resume.ts` containing `executeSubagentResume()` (from subagent.ts, updated to call enforce.ts for `--tools`, `PI_DENY_TOOLS`, `PI_SUBAGENT_AGENT` — fixing P1), `createSubagentResumeTool()` (from subagent.ts, adding optional `agent` parameter), `renderSubagentResumeCall()` (from subagent.ts), `renderSubagentResumeResult()` (from subagent.ts), and `resolveResumeLaunchBehavior()` (moved from agent.ts)
- [x] 4.2 Wire imports: resume.ts imports enforcement functions from `./enforce.ts`, surfaceReadiness/watchSubagent/runningSubagents from `./shared.ts`, loadAgentDefaults/path utils from `./agent.ts`, mux/session/types from their modules

## 5. Update agent.ts (remove enforcement exports)

- [x] 5.1 Remove `buildSubagentToolAllowlist`, `resolveDenyTools`, `buildPiPromptArgs`, `resolveLaunchBehavior`, `resolveEffectiveInteractive`, `resolveEffectiveSessionMode` from agent.ts (they now live in enforce.ts) — keep `buildAgentResourceArgs` in agent.ts (needs mux.ts). Keep all parsing, loading, path, and utility functions.
- [x] 5.2 Move `resolveResumeLaunchBehavior` from agent.ts to resume.ts (it's resume-specific)

## 6. Update index.ts (imports from new modules)

- [x] 6.1 Replace imports from `./spawner` with imports from `./spin` and `./shared` as needed
- [x] 6.2 Replace imports from `./subagent` with imports from `./spin`, `./resume`, and `./shared` as needed
- [x] 6.3 Drop dead import `resolveAgentExtensions` from `./agent.ts` in index.ts (unused after split)

## 7. Update test-slice.ts (imports)

- [x] 7.1 Replace all imports from `./spawner` and `./subagent` with imports from `./spin`, `./resume`, `./shared`, and `./enforce` matching the new module structure

## 8. Delete spawner.ts, subagent.ts

- [x] 8.1 Delete `pi-extension/subagents/spawner.ts` (all content moved to spin.ts + shared.ts)
- [x] 8.2 Delete `pi-extension/subagents/subagent.ts` (all content moved to spin.ts + resume.ts)

## 9. Fix P2/P3/P7 frontmatter mismatches

- [x] 9.1 Fix P2: update `agents/scout.md` — frontmatter `tools:` to `read, bash, write`; body "Available tools" section drops `edit` (matching frontmatter)
- [x] 9.2 Fix P3: update `agents/reviewer.md` — frontmatter `tools:` to `read, bash, write`; body "Available tools" section drops `edit` (matching frontmatter)
- [x] 9.3 Fix P7: update `agents/visual-tester.md` body "Available tools" section to remove `edit` — matching the frontmatter `tools:` field

## 10. Verify — no circular imports, all tests pass, import graph matches design

- [x] 10.1 Confirm enforce.ts imports only from agent.ts, types.ts, config.ts — NOT from spin/resume/shared
- [x] 10.2 Confirm shared.ts imports only from mux.ts, session.ts, types.ts, activity.ts, status.ts — NOT from enforce/agent/spin/resume
- [x] 10.3 Confirm agent.ts does NOT import from enforce/spin/resume/shared — it only exports to them
- [x] 10.4 Confirm spin.ts and resume.ts import enforcement from enforce.ts and shared infra from shared.ts as designed
- [x] 10.5 Run `npx tsc --noEmit` (or equivalent type-check) — zero type errors across the subagents extension (NOTE: no tsconfig.json in project; pre-existing TS5097 warnings from `.ts` extension imports are same pattern used throughout)
- [x] 10.6 Run the subagents tests (`npm test` or equivalent in the subagents workspace) — all existing tests pass without modification (NOTE: pre-existing `beforeEach is not defined` test failure, same as baseline)  
