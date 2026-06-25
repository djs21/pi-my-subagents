# agents — Bundled Agent Definitions

## Purpose

Bundled agent definitions for the pi-my-subagent extension. Each `.md` file defines an agent's default model, tools, skills, and instructions for subagent spawning.

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
- Each definition follows pi agent definition format

## Work Guidance

- Add new agents by creating a new `.md` file in this directory
- Agent definitions are auto-discovered by `agent.ts:discoverAgentDefinitions()`
- The `autoExit: true` frontmatter flag makes a subagent run autonomously (no user interaction)

## Verification

- Agent loading tested in `test/test.ts` (describe("subagent discovery"))
- Agent defaults resolution tested in `test/test.ts` (describe("agent extensions & skills"))

## Child DOX Index

*(No child AGENTS.md files — flat directory of agent definitions.)*
