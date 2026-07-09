## Context

Currently, pi assembles sub-agent prompts from 5 layers stacked with `append-system-prompt`:

1. **Pi base prompt** — coding assistant identity + pi docs/SDK paths (irrelevant to sub-agents)
2. **Agent body** — from `agents/<name>.md` body
3. **AGENTS.md chain** — DOX hierarchy from cwd to root (acceptable, can't filter)
4. **Available skills** — XML `<available_skills>` block (acceptable, can't filter)
5. **Sub-agent orchestration notice** — `<!-- subagent-orch-start -->` injected by `prompt-inject.ts` (a bug — should only apply to main agent)

The result: sub-agents receive 50%+ filler content, wasting tokens and diluting focus.

The `spawner.ts` already supports both `system-prompt: append` (default) and `system-prompt: replace` by checking frontmatter. Each `agents/<name>.md` currently uses `system-prompt: append`.

## Goals / Non-Goals

**Goals:**
- Strip irrelevant pi base layer from all 5 sub-agent types by switching to `system-prompt: replace`
- Embed tool definitions + guidelines in each agent body so replacement mode still works
- Fix orchestration notice injection bug — sub-agents shouldn't see the `<!-- subagent-orch-start -->` notice meant for the main orchestrator
- Keep AGENTS.md chain and skills block as-is (pi internal behavior, can't filter from extension)

**Non-Goals:**
- Per-agent skill allowlist (deferred)
- Removing AGENTS.md chain (pi internal, not filterable from extension code)
- Removing available skills block (pi internal, not filterable)
- Refactoring spawner.ts, mux.ts, config.ts (no changes needed)

## Decisions

**Decision 1: `system-prompt: replace` for all sub-agents**
- **Why**: The simplest way to strip Layer 1 (pi base prompt). The frontmatter field already exists, spawner already interprets it. No new configuration, no injection filtering at a lower level.
- **Alternative considered**: Post-process the prompt to strip pi docs references — more fragile, more code, and `append` mode still passes it through, so we'd have to filter every time.

**Decision 2: Embed tools + guidelines directly in each `agents/<name>.md` body**
- **Why**: With `replace` mode, the agent body becomes the entire system prompt. The sub-agent must still know its available tools (read, bash, write, edit) and usage conventions. Embedding them once per agent is the straightforward fix.
- **Alternative considered**: Add tools as a separate injection layer — that would require new extension code, new config, and defeat the purpose of simplifying the prompt architecture.

**Decision 3: Guard `prompt-inject.ts` with `PI_SUBAGENT_NAME` env var**
- **Why**: `spawner.ts` already sets `PI_SUBAGENT_NAME` for all spawned sub-agents. Checking this env var in `prompt-inject.ts:15-37` is a 2-line fix that prevents the orchestration notice from being appended to sub-agent prompts.
- **Alternative considered**: Pass a flag via the prompt injection — more invasive, env var is already set and unambiguous.

**Decision 4: No change to `spawner.ts`, `mux.ts`, or `config.ts`**
- **Why**: `spawner.ts` already reads `system-prompt` vs `append-system-prompt` from frontmatter. No new command-line flags or config keys needed. Changing `append` to `replace` in the .md frontmatter is sufficient.

## Risks / Trade-offs

- **Risk: Agent body becomes bloated with tool definitions** → Mitigation: tools are short and identical per agent type. ~15 lines of standard instructions. Accepted — still far smaller than the pi base prompt being replaced.
- **Risk: Forgetting to embed tools in a new agent `.md` file** → Mitigation: the frontmatter schema in `config.ts` validates `system-prompt` values. A missing tools block would make the agent non-functional (no read/write/edit tools), caught immediately on first spawn. Low risk.
- **Risk: `PI_SUBAGENT_NAME` env var not always set** → Mitigation: `spawner.ts` always sets it via `env.PI_SUBAGENT_NAME` when spawning. The guard is a falsy check — if somehow unset, injection runs (safe default, same as current behavior).
- **Trade-off: Can't filter AGENTS.md chain or skills block** — Accepted. These are pi internal layers. The value of stripping them does not justify forking pi's prompt assembly logic.
