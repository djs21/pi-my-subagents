# agents — Bundled Agent Definitions

## Purpose

Bundled agent definitions for the pi-my-subagent extension. Each `.md` file defines an agent's default model, tools, skills, system-prompt mode, and instructions for subagent spawning.

## Ownership

| Agent | File | Role |
|-------|------|------|
| **worker** | `worker.md` | Implements tasks from todos — writes code, runs tests, makes polished commits |
| **reviewer** | `reviewer.md` | Reviews code for bugs, security issues, correctness |
| **pnr** | `pnr.md` | Plans and researches tasks — analyzes requirements, explores codebase, produces structured plan + todos |

## Local Contracts

- Agent definitions are markdown files with YAML frontmatter for model, skills, and optional tools or deny-tools
- Bundled agents (`worker`, `reviewer`, `pnr`) do not set `tools:` in frontmatter by default to enable full tool inheritance from the host environment
- **Role safety contracts via `deny-tools`**:
  - `reviewer` enforces strict read-only auditing by denying mutation tools: `deny-tools: edit, write`
  - `pnr` enforces plan-only scoping: denies `deny-tools: edit` while retaining `write` to emit plans/artifacts
  - `worker` retains full mutation capability (`edit`, `write`) to execute tasks and code changes
- Agent names should be lowercase for case-insensitive matching in `agent.ts:loadAgentDefaults()`
- All agent defs use `system-prompt: append`. Pi automatically provides base system instructions, dynamic tool schemas, and tool usage guidelines, while the agent body appends role-specific focus, tool priorities, and workflow rules
- Agent bodies specify tool usage priorities (preferring dedicated tools over bash) without duplicating tool definitions already maintained by Pi
- Skills can be added via `skill:` (singular) or `skills:` (plural) in frontmatter, or via `agents.<name>.skills` in `subagent-config.json` (project or global)
- Agents without explicit `skill:` frontmatter inherit the parent Pi environment's skills by default (no `--no-skills`). `--no-skills` is applied only when an agent explicitly configures skills, so the explicit set is not diluted

## Work Guidance

- Add new agents by creating a new `.md` file in this directory
- Agent definitions are auto-discovered by `agent.ts:discoverAgentDefinitions()`
- Agents default to inheriting all environment tools (bundled agents omit `tools:` in frontmatter); orchestrator tools (subagent, subagent_resume, subagent_interrupt, subagent_status, subagents_list) are always denied via `enforce.ts`
- The `autoExit: true` frontmatter flag makes a subagent run autonomously (no user interaction)
- **Keep prompts minimal**: each agent body should only contain role-specific focus, tool usage priorities, and workflow rules. Do not duplicate Pi's automatic tool descriptions or base system rules.

## Verification

- Agent loading tested in `test/test.ts` (describe("subagent discovery"))
- Agent defaults resolution tested in `test/test.ts` (describe("agent extensions & skills"))

## Child DOX Index

*(No child AGENTS.md files — flat directory of agent definitions.)*
