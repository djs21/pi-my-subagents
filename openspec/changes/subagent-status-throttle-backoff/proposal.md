## Why

Rate-limited `subagent_status` responses are notices without consequences — persistent models ("nakal") keep polling every 5-6s, wasting tokens per call. The throttle caps frequency but doesn't train the model to stop. Repeated polling should become counterproductive.

## What Changes

- Add exponential backoff penalty to `subagent_status` throttle: consecutive throttled calls grow cooldown exponentially (30s → 60s → 120s → 240s, capped)
- New `throttleStrikes` counter in `shared.ts` with `effectiveInterval()` helper
- `checkStatusThrottle()` increments strikes before returning false so the notice shows the inflated (penalty) window
- `resetStatusCheckThrottle()` resets strikes to 0 (new spawn = fresh start)
- New `getStatusThrottleStrikes()` export for notice wording in index.ts
- Notice text appended when strikes > 0: "Repeated polling extends the cooldown."
- 4 new tests + 1 verification step: consecutive backoff, reset on success, reset on spawn, cap at 8x, openspec status check

## Capabilities

### New Capabilities
- `throttle-backoff`: Exponential backoff penalty on consecutive throttled subagent_status calls, capping at 8x base interval

### Modified Capabilities

## Impact

- `pi-extension/subagents/shared.ts`: New module-level `throttleStrikes`, `effectiveInterval()` helper, updated `checkStatusThrottle()` (signature stays `(): boolean` but behavior changes: increments strikes, uses effectiveInterval, updates `lastStatusCheckAt` on both paths), `getStatusThrottleRemainingMs()`, `resetStatusCheckThrottle()`, new `getStatusThrottleStrikes()` export
- `pi-extension/subagents/index.ts`: Notice text update (import `getStatusThrottleStrikes`, append penalty message)
- `pi-extension/subagents/test-slice.ts`: Expose `getStatusThrottleStrikes` in `__test__`
- `pi-extension/subagents/resume.ts`: No changes — does not call `resetStatusCheckThrottle`, reuses existing session throttle state
- `test/test.ts`: 4 new tests
- `pi-extension/subagents/AGENTS.md`: Ownership and contract updates
