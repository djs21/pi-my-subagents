## ADDED Requirements

### Requirement: send_messages tool resolves target subagent
The system SHALL provide a `send_messages` tool that accepts `id` or `name` parameters to identify the target subagent. The tool SHALL resolve the target against the `runningSubagents` map. When both `id` and `name` are provided, the tool SHALL resolve by `id` (name is ignored) — matching the convention in `interrupt.ts:resolveInterruptTarget`. If no matching running subagent is found, the tool SHALL return an error: "No running subagent matching \<id\|name\>".

#### Scenario: Resolve by id
- **WHEN** `send_messages` is called with `id` matching a running subagent
- **THEN** the tool resolves the target to that subagent and proceeds to validation

#### Scenario: Resolve by name
- **WHEN** `send_messages` is called with `name` matching a running subagent's display name
- **THEN** the tool resolves the target to that subagent and proceeds to validation

#### Scenario: No match
- **WHEN** `send_messages` is called with an `id` or `name` that does not match any running subagent
- **THEN** the tool returns an error message "No running subagent matching \<value\>" with no files written

#### Scenario: Both id and name provided
- **WHEN** `send_messages` is called with both `id` and `name` parameters
- **THEN** the tool resolves by `id` (name is ignored)

### Requirement: send_messages validates input before writing
The system SHALL validate all input constraints before writing any files. If any validation fails, no files SHALL be written (all-or-nothing).

#### Scenario: Empty messages array
- **WHEN** `send_messages` is called with `messages` array of length 0
- **THEN** the tool returns an error "requires at least 1 message" and writes no files

#### Scenario: Too many messages
- **WHEN** `send_messages` is called with `messages` array of length greater than 10
- **THEN** the tool returns an error "too many messages (max 10)" and writes no files

#### Scenario: Message too long
- **WHEN** `send_messages` is called with any message exceeding 4000 characters
- **THEN** the tool returns an error "message too long (max 4000 chars)" and writes no files

#### Scenario: Empty or whitespace-only message
- **WHEN** `send_messages` is called with any message where `trim().length === 0` (empty string or whitespace only)
- **THEN** the tool returns an error "message is empty" and writes no files

#### Scenario: Too many pending messages
- **WHEN** `send_messages` is called and the target subagent's `incoming/` directory contains more than 10 files (or the directory does not exist, which counts as 0)
- **THEN** the tool returns an error indicating the subagent has N unread messages, suggests `check_messages` is not being polled, and recommends `subagent_interrupt`. No files are written.

### Requirement: send_messages writes timestamped message files
The system SHALL write each message as a file in the target subagent's coordination directory at `<coordDir>/incoming/<timestamp>-<seq>-<random>.txt`. The timestamp SHALL be an ISO 8601 string. The sequence number SHALL be zero-indexed within the call. The random suffix SHALL be 4 hex characters from `Math.random().toString(16).slice(2, 6)`, appended to prevent filename collisions. The tool SHALL create the `incoming/` directory recursively if it does not exist. The pending file count check (which may observe a nonexistent directory as 0) SHALL run before directory creation.

#### Scenario: Single message
- **WHEN** `send_messages` is called with 1 message
- **THEN** one file is written at `<coordDir>/incoming/<timestamp>-0-<random>.txt` containing the message text

#### Scenario: Multiple messages
- **WHEN** `send_messages` is called with 3 messages
- **THEN** three files are written: `<timestamp>-0-<random>.txt`, `<timestamp>-1-<random>.txt`, `<timestamp>-2-<random>.txt` in the `incoming/` directory

#### Scenario: Directory creation
- **WHEN** `send_messages` is called and the `incoming/` directory does not exist
- **THEN** the directory is created recursively before writing

### Requirement: send_messages returns delivery confirmation
The system SHALL return a success message after writing all files: "Delivered N message(s) to \<name\>".

#### Scenario: Successful delivery
- **WHEN** `send_messages` is called with valid input and a running target
- **THEN** the tool returns "Delivered N message(s) to \<name\>" where N is the message count and name is the target's display name

### Requirement: send_messages is not rate limited
The system SHALL NOT apply any rate limiting or throttling to the `send_messages` tool. The tool is orchestrator→worker direction, opposite to polling tools.

#### Scenario: Rapid successive calls
- **WHEN** `send_messages` is called multiple times in quick succession for the same subagent
- **THEN** each call proceeds without throttle delay, subject only to the pending file count limit

### Requirement: Coordination directory single source of truth
The system SHALL provide a `getCoordDir(id)` function in `shared.ts` that returns the coordination directory path for a given subagent id. Both `spin.ts` and `resume.ts` SHALL use this function instead of computing the path independently.

#### Scenario: Consistent path
- **WHEN** `getCoordDir("abc123")` is called
- **THEN** it returns `<HOME>/.local/share/pi/subagents/abc123` (or `/tmp/.local/share/pi/subagents/abc123` if HOME is unset)

### Requirement: Resume creates coordination directory
The system SHALL create the coordination directory (`getCoordDir(id)/incoming/`) and set `PI_SUBAGENT_COORD_DIR` in the environment when resuming a subagent. This matches the behavior of `spin.ts` for new subagents.

**Current broken behavior**: Without this fix, resumed subagents' `check_messages` tool returns "Not in a coordinated subagent context." (subagent-done.ts:362) because `resume.ts` never sets `PI_SUBAGENT_COORD_DIR`. The resumed subagent cannot receive any messages from the orchestrator.

#### Scenario: Resumed subagent receives messages
- **GIVEN** a previously running subagent whose `check_messages` returns "Not in a coordinated subagent context." because `resume.ts` does not set `PI_SUBAGENT_COORD_DIR`
- **WHEN** a subagent is resumed via `subagent_resume`
- **THEN** the coordination directory is created and `PI_SUBAGENT_COORD_DIR` is set in the environment, enabling the resumed subagent's `check_messages` tool to function

#### Scenario: Resume env var set
- **WHEN** `resume.ts` builds the environment block for a resumed subagent
- **THEN** `PI_SUBAGENT_COORD_DIR` is included in the environment variables, with the value from `getCoordDir(id)`
