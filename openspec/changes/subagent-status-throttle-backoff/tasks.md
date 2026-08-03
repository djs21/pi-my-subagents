## 1. shared.ts — throttle backoff state + logic

- [ ] 1.1 Add `let throttleStrikes = 0` and `const MAX_THROTTLE_STRIKES = 3` module-level constants
- [ ] 1.2 Add `effectiveInterval()` helper: `statusConfig.minIntervalMs * 2 ** Math.min(throttleStrikes, MAX_THROTTLE_STRIKES)`
- [ ] 1.3 Update `checkStatusThrottle()` to use `effectiveInterval()`, increment `throttleStrikes++` before returning false, reset `throttleStrikes = 0` when returning true
- [ ] 1.4 Update `getStatusThrottleRemainingMs()` to use `effectiveInterval()` instead of `statusConfig.minIntervalMs`. Add guard: `if (lastStatusCheckAt === 0) return 0`
- [ ] 1.5 Update `resetStatusCheckThrottle()` to also reset `throttleStrikes = 0`
- [ ] 1.6 Add new export `getStatusThrottleStrikes(): number` returning current `throttleStrikes`

## 2. index.ts — notice text update

- [ ] 2.1 Update import line in `index.ts`: add `getStatusThrottleStrikes` to the existing `shared.ts` import statement
- [ ] 2.2 In throttled branch of `subagent_status` execute handler, append " Repeated polling extends the cooldown." when `getStatusThrottleStrikes() > 0`

## 3. test-slice.ts — expose new function

- [ ] 3.1 Import `getStatusThrottleStrikes` from shared.ts and add to `__test__` export

## 4. test/test.ts — new tests

- [ ] 4.1 Test: consecutive throttled calls grow remaining time (call checkStatusThrottle twice in quick succession, verify second remaining >= 2x base)
- [ ] 4.2 Test: successful call resets strikes to 0 (throttle twice, let interval pass, call successfully, then verify next throttled call uses base interval)
- [ ] 4.3 Test: resetStatusCheckThrottle resets strikes (throttle multiple times, call reset, verify checkStatusThrottle returns true)
- [ ] 4.4 Test: effectiveInterval caps at 8x (throttle 5+ times, verify remaining never exceeds minIntervalMs * 8)

## 5. AGENTS.md — documentation update

- [ ] 5.1 Update `shared.ts` ownership line to include `throttleStrikes`, `effectiveInterval`, `getStatusThrottleStrikes`
- [ ] 5.2 Update Local Contracts section for `subagent_status` throttle: mention backoff penalty and notice text
- [ ] 5.3 Update Verification section to mention backoff tests

## 6. Verify

- [ ] 6.1 Run `npx tsc --noEmit` — no type errors
- [ ] 6.2 Run `npm test` — all tests pass including new backoff tests
- [ ] 6.3 Run `openspec status --change "subagent-status-throttle-backoff" --json` — confirm `isComplete: true`

## 7. Interface dependency note

This change touches 5 files with an interface dependency: `index.ts` imports new `shared.ts` functions (`getStatusThrottleStrikes`). One worker, sequential: shared.ts → index.ts → test-slice.ts → test/test.ts → AGENTS.md → verify.
