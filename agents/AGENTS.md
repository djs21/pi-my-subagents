# agents — Bundled Agent Definitions

## Purpose

Bundled agent definitions for the pi-my-subagent extension. Each `.md` file defines an agent's default model, tools, skills, system-prompt mode, and instructions for subagent spawning.

## Ownership

| Agent | File | Role |
|-------|------|------|
| **planner** | `planner.md` | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout** | `scout.md` | Fast codebase reconnaissance — maps files, patterns, conventions |
| **worker** | `worker.md` | Implements tasks from todos — writes code, runs tests, makes polished commits |
| **reviewer** | `reviewer.md` | Reviews code for bugs, security issues, correctness |
| **visual-tester** | `visual-tester.md` | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing |

## Local Contracts

- Agent definitions are markdown files with YAML frontmatter for model, tools, skills, and body
- Agent names should be lowercase for case-insensitive matching in `agent.ts:loadAgentDefaults()`
- All agent defs use `system-prompt: replace` (was `append`). The body IS the complete system prompt — must contain everything the agent needs to function
- Every agent body embeds its own tool definitions block so the agent knows available tools when pi base prompt is replaced
- Skills can be added via `skill:` (singular) or `skills:` (plural) in frontmatter, or via `agents.<name>.skills` in `subagent-config.json` (project or global)
- Agents without explicit `skill:` frontmatter receive `--no-skills` by default from spawner.ts — no default skill library is injected into sub-agents

## Work Guidance

- Add new agents by creating a new `.md` file in this directory
- Agent definitions are auto-discovered by `agent.ts:discoverAgentDefinitions()`
- The `autoExit: true` frontmatter flag makes a subagent run autonomously (no user interaction)
- **Keep prompts minimal**: each agent body should only contain what that agent type needs. Tool definitions + role instructions + task workflow is enough. No pi docs references, no AGENTS.md dump, no skill library.

## Verification

- Agent loading tested in `test/test.ts` (describe("subagent discovery"))
- Agent defaults resolution tested in `test/test.ts` (describe("agent extensions & skills"))

## Child DOX Index

*(No child AGENTS.md files — flat directory of agent definitions.)*
