## Context

The subagents extension is push-based: steer messages deliver status/completion/stall events automatically. However, the model still calls `subagent_status` every <7s, wasting API tokens. Anti-polling text in tool descriptions is ignored by the model.

The tool must remain registered because it's the safety net for: (1) silent exits where a subagent dies without reporting back, (2) stalled detection edge cases, and (3) user-forced checks.

Each pi session runs as a separate Node.js process, so module-level state is naturally per-session with guaranteed isolation.

## Goals / Non-Goals

**Goals:**
- Rate-limit `subagent_status` to max once per 30s (configurable)
- Hard-block throttled calls with a short notice (not cached data) to train the model
- Reset throttle on new subagent spawn so first check after launch is always allowed
- Keep the tool registered and functional

**Non-Goals:**
- Changing internal timing (1s status refresh, 500ms activity write, exit poll)
- Disabling the tool entirely
- Adding heartbeat steers or new event types
- Client-side throttling

## Decisions

**Module-level `lastStatusCheckAt` timestamp**
- Store timestamp in `shared.ts` (where `runningSubagents` already lives) so both `index.ts` (tool handler) and `spin.ts` (spawn) can access it
- Export `resetStatusCheckThrottle()` from shared.ts, called by `spin.ts` on new spawn
- Rationale: shared.ts is the natural home for cross-module state; avoids import cycles

**Hard-block with short notice (not cached data)**
- Return "Rate-limited. Status auto-delivered via steers." when throttled
- Rationale: Data is actually always fresh (in-memory state), but hard-block trains the model to stop polling more effectively than returning data.

**Reset on new spawn**
- Call `resetStatusCheckThrottle()` from `spin.ts` when `launchSubagent` is called
- Rationale: First check after launch should always work so agent can confirm subagent started.

**Config via StatusConfig + env override**
- Add `minIntervalMs` to StatusConfig interface and parseStatusConfig
- Env override: `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS`
- Default: 30_000ms
- Rationale: Follows existing config pattern. Env override useful for testing.

## Risks / Trade-offs

- [Model still polls] → Mitigated by hard-block response training. If model ignores, at least we save tokens on server side.
- [30s too long for real stall detection] → Internal 1s refresh loop still runs. Tool is safety net, not primary mechanism.
- [Config misconfiguration] → parseStatusConfig validates; minIntervalMs enforced >= 1000ms in parser (task 1.4).
