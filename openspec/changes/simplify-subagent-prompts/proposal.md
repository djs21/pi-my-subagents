## Why

Sub-agent system prompts are bloated with irrelevant content. Pi assembles prompts from 5 layers (base coding assistant identity + pi docs/SDK paths, agent body, AGENTS.md chain, available skills, sub-agent orchestration notice), including material that sub-agents never use — pi docs paths, tool definitions duplicated from a layer they don't control, redundant identity text. This wastes tokens, slows every sub-agent call, and leaks unrelated context into focused agents like worker/scout/planner.

The fix: switch sub-agents to `system-prompt: replace` mode (stripping the pi base layer), embed only the tools and guidelines they actually need in each agent body, and fix a bug where the orchestration notice injects into sub-agents that shouldn't see it.

## What Changes

- **BREAKING**: All 5 sub-agent `.md` files change from `system-prompt: append` to `system-prompt: replace`
- Each sub-agent `.md` body gains embedded tool definitions + guidelines so replacement mode still works
- Prompt injection (`prompt-inject.ts`): skip `<!-- subagent-orch-start -->` when `PI_SUBAGENT_NAME` env var is set (sub-agent context)
- Skills constraint per agent (agent-specific skill allowlist) is **deferred** — noted but not implemented

## Capabilities

### New Capabilities
- `sub-agent-prompt-simplification`: Core capability — strip pi base layer from sub-agent prompts via `system-prompt: replace` mode, embed tools/guidelines in agent bodies, fix orchestration notice injection leak

### Modified Capabilities

*None — no existing specs.*

## Impact

**Files modified:**
- `agents/worker.md` — change frontmatter + embed tools/guidelines, strip todo-specific workflow that was compensating for append mode
- `agents/scout.md` — same pattern
- `agents/planner.md` — same pattern
- `agents/reviewer.md` — same pattern
- `agents/visual-tester.md` — same pattern
- `pi-extension/subagents/prompt-inject.ts` — add `PI_SUBAGENT_NAME` guard

**Files NOT changed:**
- `spawner.ts` — already handles `system-prompt` vs `append-system-prompt` from frontmatter
- `mux.ts`, `config.ts` — no changes needed
