## ADDED Requirements

### Requirement: All sub-agents use `system-prompt: replace` mode
Every agent `.md` file in `agents/` SHALL use `system-prompt: replace` in its frontmatter, replacing the current `system-prompt: append`.

#### Scenario: Frontmatter shows replace mode
- **WHEN** inspecting the frontmatter of `agents/worker.md`, `agents/scout.md`, `agents/planner.md`, `agents/reviewer.md`, and `agents/visual-tester.md`
- **THEN** each file SHALL have `system-prompt: replace` in its frontmatter

### Requirement: Agent bodies embed tool definitions and guidelines
Each agent `.md` body SHALL include a standard tool definitions block and a guidelines/usage block so the sub-agent knows its available tools when `system-prompt: replace` strips the pi base layer.

#### Scenario: Worker agent has tools embedded
- **WHEN** reading the body of `agents/worker.md`
- **THEN** it SHALL contain the `read`, `bash`, `write`, and `edit` tool definitions with their usage guidelines

#### Scenario: Scout agent has tools embedded
- **WHEN** reading the body of `agents/scout.md`
- **THEN** it SHALL contain the `read`, `bash`, `write`, and `edit` tool definitions with their usage guidelines

#### Scenario: Planner agent has tools embedded
- **WHEN** reading the body of `agents/planner.md`
- **THEN** it SHALL contain the `read`, `bash`, `write`, `edit`, and `subagent` tool definitions with their usage guidelines

#### Scenario: Reviewer agent has tools embedded
- **WHEN** reading the body of `agents/reviewer.md`
- **THEN** it SHALL contain the `read`, `bash`, `write`, and `edit` tool definitions with their usage guidelines

#### Scenario: Visual-tester agent has tools embedded
- **WHEN** reading the body of `agents/visual-tester.md`
- **THEN** it SHALL contain the `read`, `bash`, `write`, and `edit` tool definitions with their usage guidelines

### Requirement: Worker body removes todo-specific workflow
The `agents/worker.md` body SHALL NOT contain the old todo-specific workflow instructions that compensated for `append` mode, since the agent body now IS the system prompt and workers receive structured tasks from the orchestration layer.

#### Scenario: Worker body is task-oriented
- **WHEN** reading the body of `agents/worker.md`
- **THEN** it SHALL describe execution of assigned tasks rather than instructing the agent to process "todos" or "TodoWrite"

### Requirement: Orchestration notice skips sub-agents
`prompt-inject.ts` SHALL check for the `PI_SUBAGENT_NAME` environment variable before injecting the `<!-- subagent-orch-start -->` block. If the variable is set (meaning the current process is a sub-agent), injection SHALL be skipped.

#### Scenario: Sub-agent does not receive orchestration notice
- **WHEN** a sub-agent is spawned (e.g., `PI_SUBAGENT_NAME=worker`)
- **THEN** the `<!-- subagent-orch-start -->` block SHALL NOT appear in its assembled prompt

#### Scenario: Main agent still receives orchestration notice
- **WHEN** the main orchestrator agent runs (e.g., `PI_SUBAGENT_NAME` is not set)
- **THEN** the `<!-- subagent-orch-start -->` block SHALL still be injected as before

### Requirement: No changes to spawner, mux, or config
The implementation SHALL NOT modify `spawner.ts`, `mux.ts`, or `config.ts`. These files already support `system-prompt: replace` via frontmatter parsing and the env var `PI_SUBAGENT_NAME` is already set by spawner.

#### Scenario: spawner.ts unchanged
- **WHEN** inspecting `spawner.ts`
- **THEN** it SHALL have no changes from this change

#### Scenario: mux.ts unchanged
- **WHEN** inspecting `mux.ts`
- **THEN** it SHALL have no changes from this change

#### Scenario: config.ts unchanged
- **WHEN** inspecting `config.ts`
- **THEN** it SHALL have no changes from this change
