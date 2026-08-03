## Why

The `subagent_status` tool's throttle response is invisible and misleading. When rate-limited, the response returns `details: { agents: [] }`, which causes the renderer to display "No running subagents." — the same text shown for genuinely empty states. The model interprets this as "no work happening" and calls the tool again in a loop. Additionally, the throttle text says "Call again later" with no retry time, and provides no last-known status, leaving the model blind while throttled.

## What Changes

- Add `throttled: true` flag to the details object when the status check is rate-limited, so the renderer can distinguish throttled from genuinely empty.
- Include retry-after time in the throttle response text (e.g., "next check in 12s").
- Cache the last successful status snapshot and include it in throttled responses with an age label.
- Update the `renderResult` for `subagent_status` to check for the throttled flag first, rendering the rate-limit text instead of "No running subagents."

## Capabilities

### New Capabilities
- `throttle-response-visibility`: Ensures rate-limited subagent_status responses are distinguishable from empty states, include actionable retry timing, and carry the last-known status snapshot.

### Modified Capabilities

## Impact

- `pi-extension/subagents/shared.ts`: New exported functions (`getStatusThrottleRemainingMs`, `setStatusSnapshot`, `getStatusSnapshot`) and module-level snapshot cache.
- `pi-extension/subagents/index.ts`: Throttled branch in execute handler, snapshot caching on success, new branch at top of `renderResult`.
- `test/test.ts`: New tests for snapshot cache, throttle remaining ms, throttled response shape, and renderer behavior.
