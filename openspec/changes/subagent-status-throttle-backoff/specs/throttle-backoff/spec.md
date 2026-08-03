## ADDED Requirements

### Requirement: Consecutive throttled calls grow cooldown exponentially
The system SHALL increase the effective throttle interval by 2x for each consecutive throttled call. The first throttled call uses base interval (30s), second uses 60s, third uses 120s, etc.

#### Scenario: Second throttled call within window shows doubled remaining time
- **WHEN** `subagent_status` is called twice within the base interval (30s)
- **THEN** the remaining time returned by `getStatusThrottleRemainingMs()` SHALL be at least 2x the base interval minus elapsed time

#### Scenario: Third throttled call triples the window
- **WHEN** `subagent_status` is called three times consecutively within each respective window
- **THEN** the remaining time SHALL reflect approximately 4x the base interval

### Requirement: Cooldown is capped at 8x base interval
The effective throttle interval SHALL never exceed `minIntervalMs * 8` (e.g., 240s for 30s base), regardless of how many consecutive throttled calls occur.

#### Scenario: Four or more strikes hit the cap
- **WHEN** `checkStatusThrottle()` returns false 4 or more times consecutively without a successful call
- **THEN** the effective interval SHALL be capped at `minIntervalMs * 8`

#### Scenario: Strikes beyond cap do not increase further
- **WHEN** `checkStatusThrottle()` returns false 5 times consecutively
- **THEN** the effective interval SHALL remain `minIntervalMs * 8`

### Requirement: Successful call resets backoff to base
When `checkStatusThrottle()` returns true (call passes the throttle), the strike count SHALL reset to 0 and the next throttled call SHALL use the base interval.

#### Scenario: Reset after successful call
- **WHEN** `checkStatusThrottle()` is called and returns true (throttle passed)
- **THEN** subsequent throttled calls SHALL use the base interval (30s), not the escalated interval

### Requirement: Spawn resets backoff
When `resetStatusCheckThrottle()` is called (on new subagent spawn), the strike count SHALL reset to 0 and the throttle timer SHALL reset, so the next `subagent_status` call is always allowed.

#### Scenario: New spawn clears strikes
- **WHEN** `resetStatusCheckThrottle()` is called after consecutive throttled calls
- **THEN** `checkStatusThrottle()` SHALL return true on the next call (throttle reset)

### Requirement: Notice text indicates penalty from repeated polling
When the throttled response includes a strike count greater than 0, the response text SHALL mention that repeated polling extends the cooldown.

#### Scenario: Notice includes penalty message
- **WHEN** `subagent_status` is called while throttled with strikes > 0
- **THEN** the response text SHALL contain "Repeated polling extends the cooldown."

#### Scenario: First throttle shows penalty
- **WHEN** `subagent_status` is called while throttled with strikes == 0 (first throttle, incremented before return)
- **THEN** the response text SHALL contain "Repeated polling extends the cooldown."
