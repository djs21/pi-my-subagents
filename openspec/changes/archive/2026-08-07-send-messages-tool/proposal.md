## Why

The main agent has no tool to send messages to a running subagent. `check_messages` exists on the worker side (reads/deletes from `incoming/`), but the orchestrator has no write path — the coordination directory is one-way. Additionally, `resume.ts` does not create the coordination directory or set `PI_SUBAGENT_COORD_DIR`, so resumed subagents' `check_messages` returns "Not in a coordinated subagent context." (subagent-done.ts:362) because the env var is never set.

## What Changes

- New `send_messages` tool for the main agent: resolves a running subagent by id/name (id takes precedence when both provided), validates input, writes timestamped message files to its coordination directory
- Shared helpers in `shared.ts`: `getCoordDir(id)` and `writeIncomingMessage(coordDir, text)` — single source of truth for the coordination directory path
- Resume fix: `resume.ts` creates `coordDir/incoming/` and sets `PI_SUBAGENT_COORD_DIR` env var, matching `spin.ts` behavior
- `spin.ts` refactor: use `getCoordDir()` instead of hardcoded path (one-line change)
- `subagent-done.ts` defense-in-depth: `check_messages` filters `.txt` files only (send_messages introduces new files into `incoming/`)
- `subagent_status` tool description/promptSnippet update: reflect exponential backoff (30s→60s→120s→240s) instead of fixed 30s
- `send_messages` is NOT rate-limited — it is orchestrator→worker direction (opposite of polling)

## Capabilities

### New Capabilities

- `send-messages-tool`: Orchestrator tool to write messages into a running subagent's coordination directory. Covers tool definition, validation, message file creation, and the resume-path fix that enables messages to reach resumed subagents.

### Modified Capabilities

_`subagent_status` description/promptSnippet updated to reflect exponential backoff wording._

## Impact

- **`pi-extension/subagents/shared.ts`** — new exports: `getCoordDir`, `writeIncomingMessage`, constants
- **`pi-extension/subagents/index.ts`** — register `send_messages` tool (follows `shouldRegister` pattern)
- **`pi-extension/subagents/spin.ts`** — replace hardcoded coordDir path with `getCoordDir()` call
- **`pi-extension/subagents/resume.ts`** — add coord dir creation + `PI_SUBAGENT_COORD_DIR` env var
- **`pi-extension/subagents/test-slice.ts`** — export new helpers via `__test__`
- **`test/test.ts`** — tests for shared helpers, send_messages validation, resume coord dir
- **`pi-extension/subagents/subagent-done.ts`** — `check_messages` `.txt` file filter (defense-in-depth)
- **`pi-extension/subagents/AGENTS.md`** — ownership update for `shared.ts`
