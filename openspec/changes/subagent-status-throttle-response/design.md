## Context

The `subagent_status` tool in `pi-extension/subagents/index.ts` is rate-limited to once per 30s via `checkStatusThrottle()` in `shared.ts`. When throttled, it returns `{ details: { agents: [] }, content: [{ text: "Rate-limited: ..." }] }`. The `renderResult` at line 341 checks `details.agents.length === 0` and renders "No running subagents." — indistinguishable from a genuinely empty result. The model sees "no subagents running" and immediately retries, hitting the throttle again.

Currently `shared.ts` exposes `checkStatusThrottle()`, `resetStatusCheckThrottle()`, and `getStatusCheckInterval()`. The throttle state is `lastStatusCheckAt` (module-level `number`).

## Goals / Non-Goals

**Goals:**
- Make throttled responses visually and programmatically distinguishable from empty results
- Provide actionable retry timing in the response text
- Carry last-known status so the model doesn't panic while throttled

**Non-Goals:**
- Changing the throttle interval logic or `checkStatusThrottle` API
- Disabling the tool or adding a cooldown prompt
- Persisting snapshots across process restarts

## Decisions

**1. Explicit `throttled: true` flag in details (vs. checking agents shape)**
The renderer should not guess whether an empty agents array means "throttled" or "none running." An explicit boolean flag is unambiguous and costs one extra field. No shape-guessing.

**2. `getStatusThrottleRemainingMs()` in shared.ts (vs. computing in index.ts)**
The throttle state (`lastStatusCheckAt`, `statusConfig.minIntervalMs`) already lives in shared.ts. Computing remaining time there avoids duplicating the math and keeps index.ts thin.

**3. Snapshot cache as module-level `{ at: number; text: string } | null` in shared.ts (vs. per-subagent cache)**
A single snapshot of the last successful formatted text is sufficient. The model only needs "what did it look like N seconds ago?" — not a history. Single-entry, zero-config, no cleanup needed.

**4. Renderer checks `details.throttled` first (vs. checking text content)**
Parsing response text in the renderer is fragile. The flag is a clean contract between execute and renderResult.

## Risks / Trade-offs

- **Stale snapshot** → The snapshot age is displayed (e.g., "Last known: ... (12s ago)") so the model can judge freshness. For a 30s throttle window, staleness is bounded.
- **Snapshot memory** → Single `{ at, text }` entry. Negligible.
- **Race condition on snapshot** → Module-level state, single-threaded Node.js event loop. No risk.

## Implementation Notes

**Second renderer (renderers.ts:97):** `subagentStatusRenderer` is used for STEER messages. STEER messages are only sent on real transitions and are never throttled — no change needed there. This exists to avoid confusion during implementation: if you see two renderers for subagent status, the one in `renderers.ts` is unrelated to this change.

**`getStatusThrottleRemainingMs()` — defensive floor:** Must return `Math.max(0, statusConfig.minIntervalMs - elapsed)`. When `lastStatusCheckAt` is 0 (never checked), `elapsed` is huge and the raw subtraction goes negative. The caller sees `0` remaining, which is correct — never-checked means you can check now.

**Retry time rounding — Math.ceil:** The execute handler must use `Math.ceil(getStatusThrottleRemainingMs() / 1000)` so that e.g. 500ms → `1s`, never `0s`. Guard with `Math.max(1, ...)` if needed so the user never sees "next check in 0s".
