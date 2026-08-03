## ADDED Requirements

### Requirement: Throttled response is distinguishable
The `subagent_status` tool SHALL include `throttled: true` in the details object when the call is rate-limited, distinguishing it from a genuinely empty result.

#### Scenario: Throttled call includes flag
- **WHEN** `subagent_status` is called while rate-limited (within min interval)
- **THEN** the response details object SHALL contain `throttled: true`

#### Scenario: Non-throttled empty call has no flag
- **WHEN** `subagent_status` is called successfully with no running subagents
- **THEN** the response details object SHALL NOT contain `throttled: true`

### Requirement: Throttled response includes retry time
The throttle response text SHALL include the number of seconds until the next allowed check.

#### Scenario: Retry time in text
- **WHEN** `subagent_status` is called while rate-limited
- **THEN** the response text SHALL contain "next check in" followed by a positive integer (rounded up via Math.ceil) and "s" — e.g., 500ms remaining → "1s", never "0s"

### Requirement: Throttled response includes last-known status
The throttle response SHALL include the last successful status text with its age when available.

#### Scenario: Previous success then throttled
- **WHEN** a successful `subagent_status` call was made before the throttled call
- **THEN** the throttle response text SHALL contain "Last known:" followed by the previous status text and an age in seconds

#### Scenario: No previous success
- **WHEN** `subagent_status` is called while throttled and no prior successful call has been made
- **THEN** the throttle response text SHALL NOT contain "Last known:"

### Requirement: Renderer shows rate-limit text for throttled results
The `renderResult` for `subagent_status` SHALL render the throttle response text directly when `details.throttled` is true, rather than showing "No running subagents."

#### Scenario: Throttled result rendered
- **WHEN** `renderResult` receives a result with `details.throttled === true`
- **THEN** the rendered output SHALL contain the rate-limit text from the response

#### Scenario: Throttled result does not show empty message
- **WHEN** `renderResult` receives a throttled result
- **THEN** the rendered output SHALL NOT contain "No running subagents."

### Requirement: Renderer still shows empty message for genuine empty state
The renderer SHALL continue to display "No running subagents." when the result is not throttled and has an empty agents list.

#### Scenario: Genuine empty rendered
- **WHEN** `renderResult` receives a non-throttled result with empty agents list
- **THEN** the rendered output SHALL be "No running subagents."
