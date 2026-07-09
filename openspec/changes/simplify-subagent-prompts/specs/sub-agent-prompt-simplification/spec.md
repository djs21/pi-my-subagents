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

### Requirement: Workers and visual-testers disable context files
Sub-agents that only execute tasks without needing codebase context SHALL be spawned with `--no-context-files` flag to strip Layer 3 (AGENTS.md/CLAUDE.md) from their prompt. Scout, planner, and reviewer SHALL retain context files as they need AGENTS.md for codebase mapping.

#### Scenario: Worker spawned with --no-context-files
- **WHEN** `spawner.ts` launches a sub-agent with agent name `worker`
- **THEN** it SHALL pass `--no-context-files` flag to the pi CLI

#### Scenario: Visual-tester spawned with --no-context-files
- **WHEN** `spawner.ts` launches a sub-agent with agent name `visual-tester`
- **THEN** it SHALL pass `--no-context-files` flag to the pi CLI

#### Scenario: Scout still receives context files
- **WHEN** `spawner.ts` launches a sub-agent with agent name `scout`, `planner`, or `reviewer`
- **THEN** it SHALL NOT pass `--no-context-files` flag

### Requirement: spawer.ts updated to support per-agent context-file control
The `spawner.ts` SHALL be updated to conditionally pass `--no-context-files` based on agent type, overriding the "No changes to spawner" constraint for this specific purpose.

#### Scenario: spawner.ts modified for no-context-files
- **WHEN** inspecting `spawner.ts`
- **THEN** it SHALL contain logic to pass `--no-context-files` for `worker` and `visual-tester` agents
- **THEN** all other agent types SHALL NOT receive the flag

### Requirement: Sub-agents disable default skills
All sub-agents SHALL be spawned with `--no-skills` flag by default, since the pi default skill library (~26 skills) adds ~2500-4000 tokens to the system prompt without relevance to sub-agent tasks. Agents that need specific skills SHALL declare them via `skill` field in frontmatter, which triggers explicit `--no-skills --skill <path>` from `buildAgentResourceArgs()`.

#### Scenario: Worker spawned with --no-skills
- **WHEN** `spawner.ts` launches a sub-agent with no `skill`/`skills` frontmatter
- **THEN** it SHALL pass `--no-skills` flag to the pi CLI

#### Scenario: Visual-tester with explicit skill still works
- **WHEN** `spawner.ts` launches a sub-agent with `skill: chrome-cdp` in frontmatter
- **THEN** `buildAgentResourceArgs()` SHALL pass `--no-skills --skill chrome-cdp` (explicit skills override the default)

#### Scenario: Agent with no skills defined uses --no-skills
- **WHEN** any agent (worker, scout, planner, reviewer, visual-tester) has no `skill`/`skills` in its frontmatter
- **THEN** it SHALL receive `--no-skills` flag to strip the `<available_skills>` section
