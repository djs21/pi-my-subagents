## Context

The subagent orchestration system uses a file-based coordination directory (`~/.local/share/pi/subagents/<id>/incoming/`) for orchestrator→worker messaging. The worker side (`check_messages` tool in `subagent-done.ts`) reads and deletes files from this directory. Currently, there is no write path — the main agent has no tool to place messages into a subagent's `incoming/` directory.

Additionally, `resume.ts` does not create the coordination directory or set `PI_SUBAGENT_COORD_DIR`, so resumed subagents' `check_messages` returns "Not in a coordinated subagent context." (subagent-done.ts:362) because the env var is never set.

The `check_messages` tool reads `.txt` files from `incoming/` sorted by filename, deletes each after reading, and returns them concatenated. Filenames with timestamp prefixes ensure ordering. Currently `check_messages` reads ALL files without extension filtering — this change adds `.txt` defense-in-depth.

## Goals / Non-Goals

**Goals:**
- Provide `send_messages` tool that writes timestamped message files to a running subagent's coordination directory
- Single source of truth for coordination directory path (`getCoordDir` in `shared.ts`)
- Resume fix: create coord dir + set `PI_SUBAGENT_COORD_DIR` env in `resume.ts`
- Guard against unbounded message accumulation (backpressure via pending file count)

**Non-Goals:**
- Rate limiting on `send_messages` (orchestrator→worker direction, opposite of polling)
- Bi-directional real-time messaging (file-based, poll-driven)
- Message priority or queuing beyond filesystem ordering
- Streaming or chunked messages (4KB max per message)

## Decisions

### 1. Shared helpers in `shared.ts`

**Decision**: Add `getCoordDir(id)` and `writeIncomingMessage(coordDir, text)` to `shared.ts`.

**Rationale**: `shared.ts` already contains `runningSubagents` and other shared lifecycle infrastructure. It is imported by both `spin.ts` and `resume.ts`. Adding coord dir helpers here avoids circular dependencies and keeps the single import point.

**Alternative**: Put helpers in a new `coord.ts` module. Rejected — adds a file for two functions; `shared.ts` is the natural home.

### 2. `getCoordDir` as single source of truth

**Decision**: `getCoordDir(id)` replaces the hardcoded path at `spin.ts:80`. `spin.ts` is refactored to use it (one-line change).

**Rationale**: DRY. The path `join(process.env.HOME || "/tmp", ".local", "share", "pi", "subagents", id)` appears in spin.ts and would be duplicated in resume.ts without this helper. One function = one place to change.

**Alternative**: Keep hardcoded paths and duplicate in resume.ts. Rejected — violates DRY, creates a maintenance trap.

### 3. Backpressure: up to 10 pending files allowed

**Decision**: `send_messages` counts pending files in `incoming/` before writing. If the count exceeds 10 (`> MAX_PENDING_FILES`), reject with a message suggesting `subagent_interrupt`. If the `incoming/` directory does not exist yet, treat pending count as 0.

**Rationale**: Prevents unbounded file accumulation if `check_messages` is not being polled. Up to 10 pending files are allowed; rejection happens when more than 10 exist. The `incoming/` dir may not exist yet (just-resumed or just-spawned subagent that hasn't received messages), so `existsSync(incoming)` must be checked first — `readdirSync` on a nonexistent path throws ENOENT. Order: check pending count (missing dir = 0) → then create dir + write.

**Alternative**: No limit, rely on operator. Rejected — silent failure mode when subagent stops polling.

### 4. All-or-nothing validation

**Decision**: All guards (empty, too many, too long, too many pending) execute before any file is written. If any guard fails, no files are written.

**Rationale**: Prevents partial writes. A batch of 5 messages where the 3rd is too long should not deliver the first 2.

### 5. Timestamp-prefixed filenames with collision guard

**Decision**: Files are named `<ISO-timestamp>-<seq>-<random>.txt` (e.g., `2026-08-07T04-12-00.000Z-0-a3f2.txt`). The random suffix is 4 hex characters from `Math.random().toString(16).slice(2, 6)`, appended to prevent filename collisions when two `send_messages` calls land in the same millisecond. `check_messages` sorts by filename, so timestamp prefix ensures send order.

**Rationale**: Already the established pattern — `check_messages` uses `readdirSync().sort()`. ISO timestamps sort lexicographically. The random suffix makes collisions astronomically unlikely while keeping filenames readable.

### 6. No rate limit on `send_messages`

**Decision**: No throttle, no cooldown. The tool is orchestrator→worker, the opposite direction from `subagent_status` polling.

**Rationale**: The orchestrator needs to be able to send messages at any time (interrupt, follow-up, correction). Rate limiting would add latency to control flows.

### 7. Resume path fix

**Decision**: `resume.ts` creates `getCoordDir(id)/incoming/` and sets `PI_SUBAGENT_COORD_DIR` in the env block. Mirrors `spin.ts:80-81,207`.

**Rationale**: Without this, resumed subagents silently cannot receive messages. The fix is ~3 lines matching the existing pattern in `spin.ts`.

### 8. id/name resolution precedence

**Decision**: When both `id` and `name` are provided, resolve by `id` (name is ignored). This matches the convention in `interrupt.ts:resolveInterruptTarget`.

**Rationale**: Consistent behavior across tools. `id` is the unique key in `runningSubagents`; `name` is a display name that may not be unique. When both are present, the caller likely intended to target by id.

### 9. Empty-string message guard

**Decision**: Each message in the `messages` array must have `trim().length > 0`. Empty or whitespace-only messages are rejected before any files are written.

**Rationale**: Prevents creating empty files in `incoming/` that waste cycles in `check_messages`. All-or-nothing validation applies — one empty message in a batch rejects the entire batch.

### 10. `subagent_status` description/promptSnippet update

**Decision**: Update `subagent_status` tool description and promptSnippet in `index.ts` to reflect exponential backoff wording: "RATE LIMITED with exponential backoff (30s→60s→120s→240s). Repeated polling extends the cooldown. Status changes auto-delivered as steers."

**Rationale**: The existing description says "RATE LIMITED: max once per 30s" which contradicts the actual backoff behavior implemented in the orchestration-tools-nudge change. Since this change owns `index.ts`, the description should be updated here.

### 11. `check_messages` `.txt` file filter

**Decision**: `check_messages` in `subagent-done.ts` filters `readdirSync(incoming)` with `.filter(f => f.endsWith('.txt'))` before sorting. This is defense-in-depth — `send_messages` introduces new `.txt` files into the directory, and other stray files (`.DS_Store`, temp files) should not be read as messages.

**Rationale**: `send_messages` is the first tool that writes into `incoming/` from the orchestrator side. Adding the filter here ensures `check_messages` only processes message files it knows about. The `catch` block on unreadable files already handles errors gracefully, but the filter avoids wasted read attempts.

## Risks / Trade-offs

- **[Race condition on file creation]** → Low risk. `writeFileSync` is atomic on Linux ext4 for writes < PAGE_SIZE (4KB). Messages are ≤4000 chars. Concurrent `send_messages` calls from the orchestrator are serialized by pi's tool execution.

- **[Backpressure false positives]** → If `check_messages` deletes files between the count check and the write, no issue (count goes down). If another `send_messages` call writes between check and write, the count could go from 9 to 10, causing a rejection on the second call — correct behavior.

- **[Resume coord dir path mismatch]** → If an old subagent was spawned with a different HOME, the coord dir path could differ. Mitigated by `getCoordDir` being the single source of truth — both spin and resume use it.

- **[No message acknowledgment]** → `send_messages` writes files but has no confirmation the subagent read them. This is inherent to the file-based design; `check_messages` is poll-driven. The backpressure guard partially addresses this.
