## Context

`prompt-inject.ts` builds an orchestration section injected into the main agent's system prompt at every session start. The section lists available sub-agents and a set of orchestration tools (`subagent_status`, `subagent_interrupt`, `subagents_list`, `send_messages`) via the shared `ORCHESTRATION_TOOLS` const, followed by delegate-ON (Rules) or delegate-OFF (Guidance) instructions.

The steer mechanism already carries the session path in its content text:

```
Session: /path/to/session.jsonl
Resume: pi --session /path/to/session.jsonl
```

The `subagent_resume` tool already exists and supports switching agent identity (tools/definition) while preserving the session's conversation history. The main agent simply never defaults to it — every sub-agent is fresh-spawned. The change is a prompt convention only: no extension code changes are needed.

## Goals / Non-Goals

**Goals:**
- Teach the main agent to default to resuming a finished sub-agent's session for sequential work, using `subagent_resume(sessionPath, agent, message)`.
- Document the typical chain scout → worker → reviewer → worker, where each step resumes the previous session.
- List the narrow exceptions where fresh spawn (`subagent` tool) is still appropriate.
- Make the convention identical in both delegate paths.

**Non-Goals:**
- Changing extension runtime code (`shared.ts`, `index.ts`, `resume.ts`, `spin.ts`).
- Adding new tools, tool registration, or config.
- Adding loop guards — the main agent + user decide when a chain is done.

## Decisions

### 1. Resume = default, fresh = exception

The convention text makes `subagent_resume` the default for sequential work and lists fresh spawn as the exception (first agent, unrelated task, parallel agents). This maximizes context reuse and provider-cache hits without requiring any mechanism change.

### 2. Agent switch via parameter

`subagent_resume(agent: "worker")` loads the worker's tools/definition while preserving conversation history — identity switches, context carries. No session-copying or merge logic is needed in the prompt text; the tool handles it.

### 3. Convention lives in `ORCHESTRATION_TOOLS`-adjacent text, not a new const

The convention block is appended after the tool list inside the section builder (`formatAgentSection`). Both delegate branches already share `ORCHESTRATION_TOOLS`; adding the convention text to both Rules and Guidance arrays keeps the two paths identical without a separate const.

### 4. No loop guard

The chain ends when the main agent (with the user) decides the work is done. Adding an automatic termination mechanism would be runtime complexity beyond the prompt-only scope.

### 5. Cache efficiency rationale

The LLM provider caches the conversation prefix. Sequential resume reuses the same prefix (warm cache) instead of re-processing the full history from a fresh prompt — fewer tokens, faster responses.

## Risks / Trade-offs

- **[Risk] Prompt bloat** → Mitigated by a compact three-part block (~80–100 tokens), consistent with the existing terse one-line tool descriptions.
- **[Risk] Model may resume when a fresh spawn is better** → The exceptions list (first agent, unrelated task, parallel agents) is explicit in the convention text.
- **[Trade-off] Guidance is heuristic, not enforced** → The convention steers behavior but does not gate tools. That is intentional — the prompt is a convention, not a rule engine.

## File Scope

- `pi-extension/subagents/prompt-inject.ts` — convention text after `ORCHESTRATION_TOOLS` in both delegate branches.
- `test/test.ts` — test asserting the resume guidance appears in the injected prompt.