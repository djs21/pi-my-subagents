## 1. Shared Helpers

- [ ] 1.1 Add `MAX_MESSAGE_CHARS`, `MAX_MESSAGES_PER_CALL`, `MAX_PENDING_FILES` constants to `shared.ts`
- [ ] 1.2 Add `getCoordDir(id: string): string` to `shared.ts` — single source of truth for `~/.local/share/pi/subagents/<id>`
- [ ] 1.3 Add `writeIncomingMessage(coordDir: string, text: string): string` to `shared.ts` — creates `incoming/` dir, writes timestamped file with random suffix (`<timestamp>-<seq>-<random>.txt`), returns filename
- [ ] 1.4 In `shared.ts`, backpressure check: guard with `existsSync(incoming)` before `readdirSync` — treat missing dir as 0 pending files. Reject when count `> MAX_PENDING_FILES` (allows up to 10; rejects when more than 10)
- [ ] 1.5 In `shared.ts`, add empty-string guard: each message must have `trim().length > 0`

## 2. Resume Fix

- [ ] 2.1 In `resume.ts`, import `getCoordDir` from `shared.ts`
- [ ] 2.2 In `resume.ts`, after id generation (~line 86), create `coordDir` via `getCoordDir(id)` and `mkdirSync(join(coordDir, "incoming"), { recursive: true })`
- [ ] 2.3 In `resume.ts`, add `PI_SUBAGENT_COORD_DIR=${shellEscape(coordDir)}` to the `resumeEnvParts` array (~line 132-140)

## 3. Spin Refactor

- [ ] 3.1 In `spin.ts`, import `getCoordDir` from `shared.ts`
- [ ] 3.2 In `spin.ts`, replace hardcoded `coordDir` path (line 80) with `getCoordDir(id)`

## 4. send_messages Tool

- [ ] 4.1 In `index.ts`, import `getCoordDir`, `writeIncomingMessage`, `MAX_PENDING_FILES` from `shared.ts`
- [ ] 4.2 In `index.ts`, register `send_messages` tool inside `shouldRegister("send_messages")` guard, following the `subagent_interrupt` pattern (inline `pi.registerTool({...})`)
- [ ] 4.3 Implement tool execution: resolve target from `id`/`name` against `runningSubagents` (id takes precedence when both provided), validate all constraints (empty array, empty/whitespace-only messages, too many, too long, pending count with existsSync guard), write messages via `writeIncomingMessage`, return delivery confirmation
- [ ] 4.4 Add `renderCall` and `renderResult` functions for `send_messages`

## 5. subagent_status Description Update

- [ ] 5.1 In `index.ts`, update `subagent_status` tool description: replace "RATE LIMITED: max once per 30s" with "RATE LIMITED with exponential backoff (30s→60s→120s→240s). Repeated polling extends the cooldown. Status changes auto-delivered as steers."
- [ ] 5.2 In `index.ts`, update `subagent_status` promptSnippet to match the new backoff wording

## 6. check_messages .txt Filter (defense-in-depth)

- [ ] 6.1 In `subagent-done.ts`, add `.filter(f => f.endsWith('.txt'))` to `readdirSync(incoming)` in `check_messages` before `.sort()` — ensures only `.txt` message files are processed

## 7. Test Exports

- [ ] 7.1 In `test-slice.ts`, import and re-export `getCoordDir`, `writeIncomingMessage`, `MAX_MESSAGE_CHARS`, `MAX_MESSAGES_PER_CALL`, `MAX_PENDING_FILES` via `__test__`

## 8. Tests

- [ ] 8.1 Add tests for `getCoordDir` — returns correct path, handles missing HOME
- [ ] 8.2 Add tests for `writeIncomingMessage` — creates dir, writes file with timestamp+random prefix, returns filename
- [ ] 8.3 Add tests for `send_messages` validation — empty messages, too many, too long, empty/whitespace-only message, pending count exceeded (including nonexistent dir = 0)
- [ ] 8.4 Add tests for `send_messages` resolution — valid id, valid name, both id and name (id wins), no match
- [ ] 8.5 Add tests for resume coord dir — creates dir, sets env var

## 9. Documentation

- [ ] 9.1 Update `AGENTS.md` shared.ts ownership line to include `getCoordDir`, `writeIncomingMessage`, coordination constants
