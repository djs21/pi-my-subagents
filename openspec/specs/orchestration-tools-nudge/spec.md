# Orchestration Tools Nudge

Purpose: Nudge the main agent's system prompt with the orchestration tools it has (subagent_status with backoff, subagent_interrupt, subagents_list, send_messages).

## Requirements

### Requirement: Prompt injection lists all orchestration tools
The system prompt injection (via `registerPromptInject`) SHALL include a section that names and briefly describes each of the following tools: `subagent_status`, `subagent_interrupt`, `subagents_list`, and `send_messages`.

#### Scenario: Delegate-ON path includes all four tools
- **WHEN** `registerPromptInject` fires with delegate config enabled
- **THEN** the injected section SHALL contain the strings `subagent_status`, `subagent_interrupt`, `subagents_list`, and `send_messages`

#### Scenario: Delegate-OFF path includes all four tools (verified by construction)
- **WHEN** `registerPromptInject` fires with delegate config disabled
- **THEN** the injected section SHALL contain the strings `subagent_status`, `subagent_interrupt`, `subagents_list`, and `send_messages`

> **Testability note:** This scenario is verified by construction, not by a separate test. `getDelegateConfig()` reads the real filesystem (`~/.pi/agent/subagent-config-main.json`), so tests cannot toggle the delegate branch. Both the delegate-ON and delegate-OFF code paths reference the same shared `ORCHESTRATION_TOOLS` const — testing one path implicitly validates the other.

### Requirement: subagent_status description mentions exponential backoff
The `subagent_status` line in the injected section SHALL describe the rate-limit as exponential backoff (30s→60s→120s→240s) and note that repeated polling extends the cooldown.

#### Scenario: Backoff wording present
- **WHEN** the injected section is generated
- **THEN** the `subagent_status` line SHALL contain `backoff` and `30s` and `60s`

### Requirement: Section is bounded by HTML comment markers
The injected section SHALL be wrapped in `<!-- subagent-orch-start -->` and `<!-- subagent-orch-end -->` markers, replacing any previous section on `/reload`.

#### Scenario: Re-injection replaces existing section
- **WHEN** the system prompt already contains the start/end markers
- **THEN** the new section SHALL replace the old section between the markers

### Requirement: Injected section is identical in both delegate paths
The orchestration tools block (tool names + descriptions) SHALL be identical regardless of whether delegate mode is ON or OFF. Only the surrounding Rules/Guidance header differs.

#### Scenario: Both paths produce same tool list
- **WHEN** the delegate config is toggled between ON and OFF
- **THEN** the tool-name lines in the injected section SHALL be identical
