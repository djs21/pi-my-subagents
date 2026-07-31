## Why

The main agent polls `subagent_status` every <7 seconds, wasting API tokens. The tool is needed for silent-exit and stall detection, but the current call frequency is wasteful since status is already auto-delivered via steer messages.

## What Changes

- Add server-side throttle on `subagent_status` execute handler: 30s minimum interval between calls
- Configurable via `status.minIntervalMs` in config and `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS` env var
- Throttled calls return a short rate-limit notice (not cached data) to train the model to stop polling
- Reset throttle on new subagent spawn so first check after launch is always allowed
- Update tool description and orchestrator prompt to state rate limit

## Capabilities

### New Capabilities
- `status-rate-limit`: Server-side throttle on the subagent_status tool to prevent excessive polling

### Modified Capabilities

## Impact

- Files: `pi-extension/subagents/status.ts`, `pi-extension/subagents/index.ts`, `pi-extension/subagents/prompt-inject.ts`, `config.json.example`, `test/test.ts`
- Config schema: StatusConfig interface gains `minIntervalMs` field
- API: `subagent_status` tool returns different response when throttled
- No breaking changes: tool remains registered, behavior is backward-compatible
