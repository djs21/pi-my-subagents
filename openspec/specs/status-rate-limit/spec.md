# Status Rate Limit

Purpose: Enforce a minimum interval between `subagent_status` tool calls to prevent excessive polling by the main agent.

## Requirements

### Requirement: Rate limit subagent_status tool calls
The system SHALL enforce a minimum interval between `subagent_status` tool calls. The default interval SHALL be 30,000ms. The interval SHALL be configurable via `status.minIntervalMs` in config and `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS` env var.

#### Scenario: Call within throttle interval
- **WHEN** `subagent_status` is called less than `minIntervalMs` after the previous call
- **THEN** the tool SHALL return a short rate-limit notice (not cached data) and SHALL NOT read from `runningSubagents`

#### Scenario: Call after throttle interval
- **WHEN** `subagent_status` is called at least `minIntervalMs` after the previous call
- **THEN** the tool SHALL return the full status snapshot for all running subagents

#### Scenario: Config override via env var
- **WHEN** `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS` is set to "5000"
- **THEN** the minimum interval SHALL be 5,000ms regardless of config file value

#### Scenario: First call after spawn
- **WHEN** a new subagent is spawned via `launchSubagent`
- **THEN** the throttle timer SHALL be reset so the next `subagent_status` call is always allowed

### Requirement: Config schema accepts minIntervalMs
The system SHALL accept `minIntervalMs` as a valid key in the `status` config section. The value MUST be a positive integer. The system SHALL reject config with unsupported keys in the status section.

#### Scenario: Valid config with minIntervalMs
- **WHEN** config contains `{ "status": { "enabled": true, "minIntervalMs": 10000 } }`
- **THEN** parseStatusConfig SHALL return `{ enabled: true, lineLimit: 4, minIntervalMs: 10000 }`

#### Scenario: Invalid config key rejected
- **WHEN** config contains `{ "status": { "enabled": true, "invalidKey": true } }`
- **THEN** parseStatusConfig SHALL throw an error

### Requirement: Throttle notice is concise
The rate-limit response SHALL be a short string (under 100 characters) that informs the model the call was throttled and status is auto-delivered via steers.

#### Scenario: Throttled response format
- **WHEN** `subagent_status` is called within the throttle interval
- **THEN** the response SHALL contain the word "rate-limit" or "throttled" and mention steers
