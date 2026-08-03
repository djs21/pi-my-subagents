## 1. shared.ts — throttle remaining time + snapshot cache

- [ ] 1.1 Add `getStatusThrottleRemainingMs()` function (computes remaining time from `lastStatusCheckAt` and `statusConfig.minIntervalMs`)
- [ ] 1.2 Add module-level `lastStatusSnapshot: { at: number; text: string } | null` cache with `setStatusSnapshot(text)` and `getStatusSnapshot()` exports

## 2. index.ts — throttle response + renderer

- [ ] 2.1 Replace throttled branch in execute handler: add `getStatusThrottleRemainingMs()` for retry time, `getStatusSnapshot()` for last-known status, and `throttled: true` in details
- [ ] 2.2 Cache snapshot on successful status call via `setStatusSnapshot(lines.join("\n"))`
- [ ] 2.3 Add throttled branch at top of `renderResult`: check `details?.throttled`, render response text, skip empty-agents path

## 3. test/test.ts — new tests

- [ ] 3.1 Add test: `setStatusSnapshot`/`getStatusSnapshot` roundtrip
- [ ] 3.2 Add test: `getStatusThrottleRemainingMs` returns correct remaining time
- [ ] 3.3 Add test: throttled response includes `throttled: true` in details
- [ ] 3.4 Add test: `renderResult` renders rate-limit text when throttled (not "No running subagents")
- [ ] 3.5 Verify: `npx tsc --noEmit` + `npm test` pass

## 4. Tool description update

- [ ] 4.1 Update the `subagent_status` tool description in `index.ts` (~lines 276-293) to reflect the new richer throttled response: mention retry time, last-known status, and `throttled` flag instead of the old "returns a throttle notice" wording

## 5. AGENTS.md documentation

- [ ] 5.1 Update `pi-extension/subagents/AGENTS.md` to mention throttle response guidance (retry time + last-known status + `throttled` flag) in the `subagent_status` tool contract section

## 6. Interface dependency note

This change touches 5 files with an interface dependency: `index.ts` imports new `shared.ts` functions. Parallel worktrees would not compile. One worker, sequential: shared.ts → index.ts → test/test.ts → tool description → AGENTS.md.
