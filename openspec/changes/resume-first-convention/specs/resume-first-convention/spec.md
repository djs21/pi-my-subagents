# Resume-First Convention

## Purpose

Teach the main agent to default to resuming a finished sub-agent's session (`subagent_resume`) for sequential work instead of always fresh-spawning, reusing conversation context and the provider's cached prefix.

## Requirements

### Requirement: Resume convention in orchestrator prompt
The injected orchestration section SHALL include guidance that when a sub-agent finishes with a session path, the main agent SHALL default to resuming that session with the next agent via `subagent_resume(sessionPath, agent, message)`.

#### Scenario: Finished sub-agent steers toward resume
- **WHEN** the main agent receives a `subagent_result` steer containing a Session path
- **THEN** the convention SHALL direct it to resume that session via `subagent_resume(sessionPath: <path>, agent: "<next-agent>", message: "<task>")` to continue with context

### Requirement: Fresh spawn exceptions
The convention SHALL specify that fresh spawn (via the `subagent` tool) is appropriate only when: (a) no prior session exists, (b) the task is completely unrelated to any previous session, or (c) parallel sub-agents are needed to avoid cross-contamination.

#### Scenario: First agent in a chain fresh-spawns
- **WHEN** no prior sub-agent session exists for the task
- **THEN** the convention SHALL permit fresh spawn via the `subagent` tool

#### Scenario: Unrelated task fresh-spawns
- **WHEN** the task is completely unrelated to any previous session
- **THEN** the convention SHALL permit fresh spawn via the `subagent` tool

#### Scenario: Parallel sub-agents fresh-spawn
- **WHEN** multiple sub-agents run in parallel
- **THEN** the convention SHALL permit fresh spawn via the `subagent` tool to avoid cross-contamination

### Requirement: Typical chain documented
The convention SHALL include the example chain scout → worker → reviewer → worker, showing how each step resumes the previous session.

#### Scenario: Chain example present in prompt
- **WHEN** the injected section is generated
- **THEN** it SHALL contain the chain `scout → worker → reviewer → worker` with each step resuming the prior session

### Requirement: Present in both delegate paths
The resume convention SHALL appear identically in both the delegate-ON (Rules) and delegate-OFF (Guidance) orchestrator prompt paths.

#### Scenario: Delegate-ON path includes convention
- **WHEN** `registerPromptInject` fires with delegate config enabled
- **THEN** the injected Rules section SHALL contain the resume-first convention text

#### Scenario: Delegate-OFF path includes convention
- **WHEN** `registerPromptInject` fires with delegate config disabled
- **THEN** the injected Guidance section SHALL contain the same resume-first convention text

> **Testability note:** Both delegate branches share the same convention text source, mirroring the existing `ORCHESTRATION_TOOLS` pattern. Tests verify the delegate-OFF path (default config); the delegate-ON path is verified by construction since both branches reference identical text.