## Context

`prompt-inject.ts` builds an orchestration section injected into the main agent's system prompt at every session start. The section currently lists available sub-agents and a single rule about `subagent_status` rate-limiting ("once per 30s"). Three other orchestration tools (`subagent_interrupt`, `subagents_list`, `send_messages`) are registered but never mentioned in the prompt — the model must discover them from tool descriptions.

The backoff behavior was added to `shared.ts` (30s→60s→120s→240s, MAX_THROTTLE_STRIKES=3, 8x cap) but the prompt text was not updated to reflect it.

## Goals / Non-Goals

**Goals:**
- Mention all four orchestration tools in the injected section so the model knows they exist without reading tool schemas.
- Update `subagent_status` wording to match the actual backoff behavior.
- Keep the block compact — ~100 extra tokens per session start.
- Add a test verifying the injected section contains all four tool names.

**Non-Goals:**
- Changing runtime tool behavior, throttle logic, or `shared.ts`.
- Restructuring the `formatAgentSection` function or refactoring prompt-inject.ts.
- Adding prompt injection for sub-agents (already skipped via `PI_SUBAGENT_NAME` guard).

## Decisions

### 1. Shared tool list extracted into a constant

The four tool description lines are identical in both delegate-ON and delegate-OFF paths. Extract them into a `const ORCHESTRATION_TOOLS` array at module scope, referenced by both branches. This avoids duplication and ensures both paths stay in sync.

**Alternative considered:** Inline the lines in both branches (current approach for other rules). Rejected because the block is the same text — duplication invites drift.

### 2. Tool descriptions are single-line, terse

Each tool gets one line: name in backtick, em dash, short description. No multi-line explanations. Token budget matters — this is injected every session.

### 3. Test calls `registerPromptInject` with a mock `ExtensionAPI` and captures the `before_agent_start` callback

The existing `createMockExtensionApi()` in test.ts provides a mock `pi`. The test will:
1. Call `registerPromptInject(mockPi)`.
2. Extract the `before_agent_start` handler from `mockPi.on()`.
3. Invoke it with a fake event containing a system prompt.
4. Assert the resulting system prompt contains all four tool names.

This requires adding a `capturedHandlers` map to the mock (or using the existing `on()` stub). The simplest approach: make `on()` store callbacks in a map so the test can invoke them.

## Risks / Trade-offs

- **[Risk] Prompt bloat** → Mitigated by keeping each line under 15 words. Total addition ~50–70 tokens.
- **[Risk] Slice B (`send_messages`) must land after this** → The proposal documents this dependency. Both slices share a campaign; A merges first.
- **[Trade-off] No per-tool detail** → The prompt only names tools + one-line purpose. If the model needs more, it reads tool descriptions. This is intentional: the prompt is a nudge, not documentation.

## Cross-Slice Notes

- **`subagent_status` tool description/promptSnippet wording update** (`index.ts:282-290`): The `description` and `promptSnippet` fields still say "RATE LIMITED: max once per 30s", which contradicts the new backoff prompt text. This fix is tracked in the companion change `send-messages-tool` to avoid file contention; both land in the same campaign.
