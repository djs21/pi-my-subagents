## Why

The main agent's system prompt only mentions `subagent_status` — it has no knowledge of `subagent_interrupt`, `subagents_list`, or the upcoming `send_messages` tool without reading tool descriptions. This wastes tokens at inference time (the model re-discovers them each turn) and means the orchestrator may not use them when appropriate (e.g., interrupting a stall, listing available agents, or sending follow-up instructions).

## What Changes

- Replace the single `subagent_status` rate-limit line in the injected orchestration section with a compact "orchestration tools" block covering all four tools: `subagent_status`, `subagent_interrupt`, `subagents_list`, `send_messages`.
- The new block is identical in both delegate-ON (Rules) and delegate-OFF (Guidance) paths.
- `subagent_status` wording is updated to reflect exponential backoff (30s→60s→120s→240s, repeated polling extends cooldown) instead of the current flat "once per 30s".
- Add a test that verifies `registerPromptInject` injects a section containing all four tool names.

## Capabilities

### New Capabilities

- `orchestration-tools-nudge`: Prompt injection that lists all orchestration tools with compact descriptions in the main agent's system prompt.

### Modified Capabilities

<!-- none — the throttle-backoff spec is unchanged; only the prompt wording is updated -->

## Impact

- Files: `pi-extension/subagents/prompt-inject.ts` (prompt text), `test/test.ts` (new test).
- No runtime behavior change — this is prompt text only. Token budget per session start increases by ~50–70 tokens.
- Slice B (`send-messages-tool`) depends on this change mentioning `send_messages` in the prompt block.
- **[Cross-slice]** The `subagent_status` tool description/promptSnippet wording update (`index.ts:282-290`) is tracked in the companion change `send-messages-tool` to avoid file contention; both land in the same campaign.
- **[Merge constraint]** Both slices A (this change) and B (`send-messages-tool`) MUST land in the same merge session, A then B. Between A and B, the model will see `send_messages` in the prompt but the tool is not yet registered, causing tool-not-found errors if invoked.
