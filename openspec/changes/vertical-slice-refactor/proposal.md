## Why

The subagents extension has grown organically — enforcement logic, spawn lifecycle, and resume lifecycle are mixed across `agent.ts`, `spawner.ts`, and `subagent.ts`. `executeSubagentResume()` duplicates ~30 lines of surface readiness code and bypasses all tool enforcement that `launchSubagent()` implements. Adding a new feature or fixing enforcement requires touching 3-4 files, and the risk of missing a code path (like the resume gap) is high. This refactoring partitions the code into clean vertical slices so each concern is independently understandable, testable, and safe to change.

## What Changes

- **NEW** `enforce.ts` — shared config builder: agent defaults → CLI flags (tools, deny, model, skills, no-context-files)
- **NEW** `shared.ts` — shared infra: `watchSubagent()`, `surfaceReadiness()`, `runningSubagents` singleton
- **NEW** `spin.ts` — new sub-agent launch: `launchSubagent()`, tool creator, renderers, execute handler
- **NEW** `resume.ts` — resume sub-agent: `executeSubagentResume()`, tool creator, renderers, includes enforcement (fixes P1)
- **MODIFIED** `agent.ts` — trimmed to config parsing + agent loading only (enforcement functions move to `enforce.ts`)
- **REMOVED** `spawner.ts` — folded into `spin.ts` + `shared.ts`
- **REMOVED** parts of `subagent.ts` — spawn parts → `spin.ts`, resume parts → `resume.ts`
- **FIX** P1 (resume bypass) — resume.ts uses enforce.ts, same as spin.ts
- **FIX** P2/P3/P7 — frontmatter tool mismatches for scout, reviewer, visual-tester

## Capabilities

### New Capabilities
- `module-restructuring`: Refactor `pi-extension/subagents/` from horizontal (agent.ts/spawner.ts/subagent.ts) to vertical slices (enforce.ts/spin.ts/resume.ts/shared.ts). Pure code organization change — no external behavior changes.

### Modified Capabilities
<!-- No existing specs change — this is internal restructuring only -->

## Impact

**Files affected:**
- `pi-extension/subagents/enforce.ts` — new
- `pi-extension/subagents/shared.ts` — new
- `pi-extension/subagents/spin.ts` — new
- `pi-extension/subagents/resume.ts` — new
- `pi-extension/subagents/agent.ts` — modified (trimmed)
- `pi-extension/subagents/spawner.ts` — removed
- `pi-extension/subagents/subagent.ts` — removed
- `pi-extension/subagents/index.ts` — import paths updated
- `pi-extension/subagents/test-slice.ts` — import paths updated
- `agents/scout.md` — frontmatter `tools: read, bash, write` (fix P2)
- `agents/reviewer.md` — frontmatter `tools: read, bash, write` (fix P3)
- `agents/visual-tester.md` — body tool list removes `edit` (fix P7)

**No external API changes.** All tool names (`subagent`, `subagent_resume`, `subagent_interrupt`) remain identical. No config format changes.
