## Why

The main agent spawns sub-agents (scout, worker, reviewer) but always uses a fresh spawn via the `subagent` tool. Sequential work chains (scout → worker → reviewer → worker) re-investigate what the previous agent already learned, wasting context and tokens. `subagent_resume` already supports switching agent identity while preserving session history (conversation context), so the LLM provider's cached conversation prefix is reused — sequential resume = warm cache = fewer tokens re-processed.

## What Changes

- Add a "Resume-First Convention" section to the injected orchestration prompt in `prompt-inject.ts`, placed after the `ORCHESTRATION_TOOLS` tool list, inside the section markers.
- The section teaches the main agent to default to `subagent_resume(sessionPath, agent, message)` when a sub-agent finishes with a session path, reserving fresh spawn (`subagent` tool) for: the first agent in a chain, unrelated tasks, and parallel sub-agents.
- The section appears identically in both the delegate-ON (Rules) and delegate-OFF (Guidance) paths.
- Add a test verifying the resume guidance is present in the injected prompt.

## Capabilities

### New Capabilities

- `resume-first-convention`: Prompt convention teaching the main agent to resume prior sub-agent sessions for sequential work instead of fresh-spawning.

### Modified Capabilities

<!-- none — no runtime behavior changes -->

## Impact

- Files: `pi-extension/subagents/prompt-inject.ts` (prompt text only), `test/test.ts` (new test).
- No extension runtime changes, no config changes, no tool registration changes, no `shared.ts` / `index.ts` / `resume.ts` / `spin.ts` changes.
- Token budget per session start increases modestly (~80–100 tokens) for the new convention block.