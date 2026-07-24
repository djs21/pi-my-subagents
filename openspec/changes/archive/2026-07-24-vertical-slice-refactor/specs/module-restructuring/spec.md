## ADDED Requirements

### Requirement: enforce.ts owns enforcement config building
The `enforce.ts` module SHALL contain all logic for converting agent definitions into sub-agent CLI flags and environment variables. It SHALL NOT import from `spin.ts`, `resume.ts`, or `shared.ts`.

#### Scenario: enforce.ts provides buildSubagentToolAllowlist
- **WHEN** `buildSubagentToolAllowlist(effectiveTools)` is called with a comma-separated tool string
- **THEN** it SHALL return the allowlist CSV with SUBAGENT_CONTROL_TOOLS appended, defaulting to `read,bash` when input is empty

#### Scenario: enforce.ts provides resolveDenyTools
- **WHEN** `resolveDenyTools(agentDefs)` is called with a nullable AgentDefaults
- **THEN** it SHALL return a Set of denied tool names derived from `spawning: false` and `deny-tools` frontmatter

#### Scenario: enforce.ts provides buildPiPromptArgs
- **WHEN** `buildPiPromptArgs(params)` is called
- **THEN** it SHALL return prompt-related CLI args

**NOTE:** `buildAgentResourceArgs` stays in agent.ts (needs mux.ts's shellEscape and private scanSkillDir) — enforce.ts imports it from agent.ts rather than owning it.

### Requirement: shared.ts owns shared lifecycle infra
The `shared.ts` module SHALL contain surface readiness, `watchSubagent()`, `getModuleAbortSignal()`, the `runningSubagents` singleton, widget wrappers (`updateWidget`, `startWidgetRefresh`, `setLatestCtx`, `latestCtx`), and any launch script helpers. It SHALL NOT import from `enforce.ts`, `agent.ts`, `spin.ts`, or `resume.ts` — only from `mux.ts`, `session.ts`, `types.ts`, `activity.ts`, `status.ts`.

#### Scenario: shared.ts exports surfaceReadiness helper
- **WHEN** both spin and resume need to wait for shell readiness before launching pi
- **THEN** they SHALL call a shared helper from `shared.ts` instead of duplicating the ~30-line polling block

#### Scenario: shared.ts exports watchSubagent
- **WHEN** both `spin.ts` (new spawn) and `resume.ts` (resume) need to watch a running sub-agent
- **THEN** they SHALL call `watchSubagent` from `shared.ts`

#### Scenario: shared.ts exports runningSubagents
- **WHEN** `spin.ts`, `resume.ts`, `index.ts` (interrupt), and `test-slice.ts` need to access running subagent state
- **THEN** they SHALL import `runningSubagents` from `shared.ts`

### Requirement: spin.ts owns new sub-agent launch
The `spin.ts` module SHALL contain the full lifecycle for spawning a new sub-agent: loading enforcement config from `enforce.ts`, creating mux surface (using `shared.ts` readiness), seeding session, launching pi, and returning a `RunningSubagent`. It SHALL export `launchSubagent()`, `createSubagentTool()`, `executeSubagentTool()`, and render functions.

#### Scenario: spin.ts tool creator produces subagent tool
- **WHEN** `createSubagentTool(pi)` is called
- **THEN** it SHALL return a tool definition object with name `"subagent"`, matching the current `subagent.ts:313` output

#### Scenario: spin.ts executeSubagentTool calls launchSubagent
- **WHEN** `executeSubagentTool()` is invoked
- **THEN** it SHALL call `launchSubagent(params, ctx)` from the same module, with the same parameters as currently

### Requirement: resume.ts owns sub-agent resume
The `resume.ts` module SHALL contain the full lifecycle for resuming an existing sub-agent session: loading enforcement config from `enforce.ts` (fixes P1), creating mux surface (using `shared.ts` readiness), building pi command with `--session`, and returning a `RunningSubagent`. It SHALL export `executeSubagentResume()`, `createSubagentResumeTool()`, and render functions.

#### Scenario: resume.ts enforces tools via enforce.ts
- **WHEN** `executeSubagentResume()` is called with an `agent` parameter
- **THEN** it SHALL call `enforce.ts` functions to build `--tools`, `PI_DENY_TOOLS`, and `PI_SUBAGENT_AGENT` — matching what `launchSubagent()` does for spawns

#### Scenario: resume.ts tool creator produces subagent_resume tool
- **WHEN** `createSubagentResumeTool(pi)` is called
- **THEN** it SHALL return a tool definition object with name `"subagent_resume"`, matching the current `subagent.ts:339` output, with an additional optional `agent` parameter

### Requirement: agent.ts is trimmed to parsing and loading only
The `agent.ts` module SHALL retain only config parsing (`parseAgentDefinition`, `getFrontmatterValue`, `parseOptionalBoolean`, `parseSessionMode`), agent loading (`loadAgentDefaults`, `resolveAgentByPrefix`, `discoverAgentDefinitions`), path helpers (`resolveSubagentPaths`, `getDefaultSessionDirFor`, `getArtifactDir`, `getBundledAgentsDir`, `getAgentConfigDir`), and utilities (`formatElapsed`, `getShellReadyDelayMs`, `muxUnavailableResult`, `activityLabel`). It SHALL NOT import from `enforce.ts`, `spin.ts`, `resume.ts`, or `shared.ts`.

#### Scenario: agent.ts no longer exports enforcement functions
- **WHEN** inspecting `agent.ts` exports after refactoring
- **THEN** it SHALL NOT export `buildSubagentToolAllowlist`, `resolveDenyTools`, `buildPiPromptArgs`, `resolveLaunchBehavior`, `resolveEffectiveInteractive`, `resolveEffectiveSessionMode`, or `resolveResumeLaunchBehavior`

**NOTE:** `buildAgentResourceArgs` STAYS in agent.ts (not moved to enforce.ts) — it is exported and available for import by spin.ts, resume.ts, and any other client.

### Requirement: scout and reviewer frontmatter includes write tool, body drops edit
Scout and reviewer agents SHALL have `write` in their frontmatter `tools:` list. The body "Available tools" section SHALL drop `edit` to match the frontmatter. The body instruction "Use the `write` tool to save your findings" SHALL match the available tools.

#### Scenario: scout frontmatter has write
- **WHEN** reading `agents/scout.md` frontmatter
- **THEN** it SHALL have `tools: read, bash, write`

#### Scenario: reviewer frontmatter has write
- **WHEN** reading `agents/reviewer.md` frontmatter
- **THEN** it SHALL have `tools: read, bash, write`

### Requirement: visual-tester frontmatter matches body tool list
Visual-tester frontmatter SHALL either include `edit` in its `tools:` list or the body SHALL remove `edit` from the "Available tools" section. Visual-tester does not need edit capability.

#### Scenario: visual-tester body tool list matches frontmatter
- **WHEN** reading `agents/visual-tester.md`
- **THEN** the "Available tools" section in the body SHALL list exactly the same tools as the frontmatter `tools:` field
