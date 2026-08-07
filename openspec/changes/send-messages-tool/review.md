# Code Review: send-messages-tool (OpenSpec Proposal)

**Reviewed:** `openspec/changes/send-messages-tool/` — proposal.md, design.md, specs/send-messages-tool/spec.md, tasks.md
**Verdict:** APPROVED with notes

## Summary

Design is solid and well-aligned with the existing codebase. The `getCoordDir` single-source-of-truth pattern, the resume fix, and the backpressure guard are all correct. Four P1 issues below should be addressed before/alongside implementation; the rest are P2 polish.

## Findings

### [P1] Backpressure check crashes when `incoming/` doesn't exist yet

**Location:** spec line 33-35, design decision 3

**Issue:** The backpressure check is `readdirSync(incoming).length >= 10`. But `incoming/` may not exist yet — e.g., a just-resumed or just-spawned subagent that hasn't received any messages (the dir is created by `spin.ts`/`resume.ts` only if implemented, and even then `send_messages` can race before the dir exists). `readdirSync` on a nonexistent path throws `ENOENT`.

**Suggested Fix:** Guard with `existsSync(incoming)` first; treat nonexistent dir as 0 pending files. The spec's "Scenario: Directory creation" (line 48-50) says the dir is created recursively before writing, but the backpressure check runs BEFORE any write/dir creation. The implementation must handle this order: check pending count (treat missing dir as 0) → then create dir + write.

### [P1] Timestamp collision between two rapid `send_messages` calls

**Location:** design decision 5, spec line 38

**Issue:** Filenames are `<ISO-timestamp>-<seq>.txt` where `<seq>` is zero-indexed within a single call. Two separate calls within the same millisecond would produce the same timestamp. Since `-<seq>` only distinguishes messages within one call, two calls at the same ms would both write `2026-08-07T04-12-00.000Z-0.txt` — the second overwrites the first.

**Mitigation:** The design's risk section claims pi serializes tool execution, which is true for the main agent. However, the resume path also creates message files (resume.ts:123-129). If a resume message happens to share the timestamp with a `send_messages` call, there's no conflict because they write to different directories (artifact dir vs coord dir). So this is unlikely to happen in practice.

**Suggested Fix:** Use a higher-resolution timestamp (e.g., `process.hrtime.bigint()` or `Date.now()` + a monotonic counter per `writeIncomingMessage` call) for the filename prefix, OR add a random suffix. The safest: `Date.now() * 1000000 + <hrtime-nanoseconds>` or simply append `Math.random().toString(16).slice(2, 6)`.

### [P1] `check_messages` doesn't handle `.txt` extension filter

**Location:** `subagent-done.ts:373` — `readdirSync(incoming).sort()`

**Issue:** `readdirSync` returns ALL files in the directory. If any other file (e.g., `.DS_Store`, a stray temp file, a `.md` from an unrelated process) ends up in `incoming/`, `check_messages` would try to read it as a UTF-8 message, potentially crashing or returning garbage. The `catch` on line 386 silently skips unreadable files, so it wouldn't crash — but it would still try and fail, wasting cycles.

**Suggested Fix:** Filter for `.txt` files in `check_messages`: `readdirSync(incoming).filter(f => f.endsWith('.txt')).sort()`. This is a defense-in-depth change to `subagent-done.ts`, not `send_messages` itself, but should be part of this change since `send_messages` introduces new files into that directory.

### [P1] Spec doesn't acknowledge the full resume gap

**Location:** spec line 73-78

**Issue:** The spec says the resume fix "enabl[es] the resumed subagent's check_messages tool to function" but never explicitly states that currently `check_messages` returns `"Not in a coordinated subagent context."` for resumed subagents (subagent-done.ts:362). The proposal.md mentions it ("resumed subagents silently cannot receive messages"), but the spec should include this as context.

**Suggested Fix:** Add a note or a `GIVEN` clause in the resume scenario stating the current broken behavior, so the spec documents what defect it's fixing.

### [P2] Both `id` and `name` provided — precedence undefined

**Location:** spec lines 3-16

**Issue:** The spec has separate scenarios for "Resolve by id" and "Resolve by name" but doesn't define behavior when both are provided. The existing `interrupt.ts:resolveInterruptTarget` prioritizes `id` over `name` — `send_messages` should follow the same convention, and the spec should mention it.

**Suggested Fix:** Add a scenario: "WHEN both `id` and `name` are provided, THEN resolve by `id` (name is ignored)." OR state that the tool follows the same resolution precedence as `subagent_interrupt`.

### [P2] "Max 10 pending files" wording vs actual guard

**Location:** proposal.md line 6 ("max 10 pending"), spec line 34 ("10 or more files"), design decision 3 (`>= 10`)

**Issue:** The guard rejects at `>= 10`, meaning at most **9** files can be pending before rejection. The proposal says "max 10 pending" which implies 10 is allowed. The spec (line 34) correctly says "10 or more files" triggers the error. The wording in the proposal is slightly misleading.

**Suggested Fix:** Change proposal wording to "max 9 pending files before rejection" or make the spec/design guard `> 10` to match the intent.

### [P2] Empty-string messages not guarded

**Location:** spec line 25-27

**Issue:** The spec only guards against `messages.length === 0`, not against individual empty strings like `[""]` or `[" ", "hello"]`. An empty message would create an empty file in `incoming/`, and `check_messages` would `.trim()` it to an empty string — harmless but wasteful.

**Suggested Fix:** Add a guard: each message string must have `trim().length > 0`. Or leave it — `check_messages` handles empty content gracefully. Low priority.

## What's Good

- **Design is DRY.** `getCoordDir` as single source of truth eliminates the hardcoded path duplication that already exists between spin.ts:80 and the incoming resume fix.
- **All-or-nothing validation** is correctly positioned BEFORE writes — guards execute, then files are written. The intent is clear even if filesystem operations aren't transactional.
- **Backpressure via pending file count** is the right approach for a file-based poll system. 10 is reasonable; the error message guiding toward `subagent_interrupt` is thoughtful UX.
- **`shouldRegister` pattern** — the proposal correctly follows the existing tool registration convention in index.ts:168.
- **Resume fix placement** (tasks 2.2-2.3) correctly mirrors spin.ts:80-81 and spin.ts:207 — coord dir creation and env var in the right locations.
- **No rate limit** decision is correct — orchestrator→worker is a control path, not a polling path.
- **Spec scenarios** cover the key paths: resolve by id, resolve by name, no match, empty, too many, too long, pending overflow, single message, multiple messages, dir creation, delivery confirmation, no rate limit — comprehensive.
