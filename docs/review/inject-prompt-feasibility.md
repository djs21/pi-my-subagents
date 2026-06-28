# Code Review: System Prompt Injection for Sub-Agent Orchestration

**Reviewed:** Feasibility analysis for injecting an orchestrator reminder into the main agent's system prompt via `before_agent_start` hook

**Verdict:** APPROVED — technically feasible, well-aligned with SDK capabilities

---

## Summary

The plan is sound and builds on proven patterns. The subagent extension already has all the building blocks (agent discovery, config system, hook registration). Potential issues are manageable and not blockers — they need design decisions and edge-case handling, not architectural changes.

---

## Findings

### [P0] /reload causes duplicate system prompt injection

**File:** `pi-extension/subagents/index.ts` (hook registration area)

**Issue:** When `/reload` fires, the old extension module's `before_agent_start` handler survives in pi's event system while the new module registers a second handler. Both fire, injecting the orchestrator reminder twice (or more if `/reload` is called multiple times). The extension already handles this pattern for timers via `Symbol.for("pi-subagents/poll-abort-controller")` — but that's for `AbortController`, not event listeners. Hook deregistration is not part of the SDK API, so old handlers persist.

**Suggested Fix:** Use a sentinel check inside the handler. Before injecting, scan `event.systemPrompt` for a unique marker string (e.g., `<!-- subagent-orchestrator -->`). If found, return early. This is simple, reliable, and survives any number of `/reload` cycles:

```typescript
const ORCHESTRATOR_MARKER = "<!-- subagent-orchestrator -->";

pi.on("before_agent_start", async (event, ctx) => {
  if (event.systemPrompt.includes(ORCHESTRATOR_MARKER)) {
    return; // Already injected by this or a prior handler
  }
  return {
    systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_MARKER}\n...`,
  };
});
```

**Alternative:** Maintain a `WeakSet<ExtensionContext>` or a Set of session IDs that have received the injection. Check before injecting. The substring check is simpler and doesn't require tracking state across reloads.

---

### [P1] No mechanism to unregister hooks — cumulative bloat risk

**File:** SDK — `pi.on()` API (no `pi.off()` or `pi.removeListener()`)

**Issue:** The SDK does not expose an `off()` method. Every `/reload` adds listeners without removing stale ones. While the substring check prevents duplicate prompt injection, old handlers still execute (doing the substring check and returning early). With enough reloads, this becomes observable overhead and a source of confusion during debugging.

**Suggested Fix:**
1. Document this limitation in the extension AGENTS.md
2. Use a module-level registration guard that detects if this is a reload vs a fresh load
3. The `ctx.sessionManager` API could be used to store a flag: in `session_start`, set a session-level flag. In `before_agent_start`, check if this extension's injection was already applied to this session. (But note: on `/reload`, `session_start` fires again, so this needs care.)

**Best option:** Use the `Symbol.for()` pattern that the extension already uses for `POLL_ABORT_KEY`. Store a module version symbol; the handler checks if its own module version matches the global reference and skips if outdated:

```typescript
const MODULE_VERSION_KEY = Symbol.for("pi-subagents/prompt-inject-version");
const MY_VERSION = Symbol("inject-v1");

const current = (globalThis as any)[MODULE_VERSION_KEY];
if (current && current !== MY_VERSION) {
  // Another instance already registered — don't double-register
  // But we can't unregister old ones...
}
```

This is a workaround, not a fix. The SDK should ideally support handler deregistration or deduplication.

---

### [P1] Config schema: `includeAgents: ["*"]` is confusing — needs allowlist/denylist clarity

**File:** Config schema design

**Issue:** The draft schema uses `includeAgents` with `"*"` as a wildcard. This conflates two concepts: "include all" vs "include specific". A wildcard in a list field is unusual and ambiguous — is it `["*"]` (allow all) or `[]` (allow none)? Also, there's no denylist pattern, which users would naturally expect for excluding specific agents.

**Suggested Fix:** Use separate `allowlist` and `denylist` fields, both arrays of agent names. The `allowlist` with `["*"]` is a clear "allow all" convention. Denylist takes precedence:

```json
{
  "orchestratorPrompt": {
    "enabled": true,
    "style": "compact",
    "allowlist": ["*"],
    "denylist": ["claude-code"]
  }
}
```

Implementation logic:
```typescript
function filterAgents(allAgents, allowlist, denylist) {
  if (denylist.includes("*")) return []; // all denied
  const allowed = allowlist.includes("*")
    ? allAgents
    : allAgents.filter(a => allowlist.includes(a.name));
  return allowed.filter(a => !denylist.includes(a.name));
}
```

---

### [P1] `style: "minimal" | "detailed"` is too coarse — needs a `format` field or template

**File:** Config schema design

**Issue:** A binary style choice can't capture what users actually want. Some want just the name + one-line description. Others want name + description + tools + model. Still others want to control the exact wording of each agent entry.

**Suggested Fix:** Replace `style` with `format` accepting: `"compact"` (name + description on one line), `"standard"` (name + description + tools + model), `"detailed"` (full frontmatter dump). OR better: let `format` be a template string with `{name}`, `{description}`, `{tools}`, `{model}` placeholders, defaulting to `"- {name}: {description}"`:

```json
{
  "orchestratorPrompt": {
    "enabled": true,
    "format": "compact",
    "allowlist": ["*"],
    "denylist": [],
    "placement": "append",
    "header": "## Available Sub-Agents\n\nYou are an orchestrator. Delegate work to these agents:",
    "footer": "\nUse the `subagent` tool to delegate tasks."
  }
}
```

Template approach is overkill for v1. Recommended: simple `format: "compact" | "standard"`, with `header` and `footer` for custom text.

---

### [P2] No token budget control for large agent lists

**File:** Config schema / injection logic

**Issue:** With 10+ agents in "standard" format (name + description + tools + model), each entry is ~80-100 tokens. 10 entries = 800-1000 tokens. The system prompt for pi is already large (tool definitions, guidelines, context files). Adding 1K tokens for agent list is meaningful.

**Token estimate:**

| Format | Per agent (tokens) | 5 agents | 10 agents | 20 agents |
|--------|-------------------|----------|-----------|-----------|
| compact (name+desc) | ~30-40 | 150-200 | 300-400 | 600-800 |
| standard (+tools+model) | ~80-100 | 400-500 | 800-1000 | 1600-2000 |

**Suggested Fix:** Add an optional `maxAgents` field (default: 15). If the agent list exceeds this, use compact format regardless of the configured style. Include a note: "and N more agents (use /subagents_list to see all)".

Also consider: use `systemPromptOptions.selectedTools` to only list agents whose tools overlap with the active tool set? This is clever but may be surprising to users. Better to just cap by count.

---

### [P2] Dynamic agent changes mid-session not reflected immediately

**File:** Injection logic

**Issue:** `discoverAgentDefinitions()` re-scans the filesystem each call, so new agents appear on the next user prompt. This is correct behavior but could surprise users. If someone installs an agent and expects it to show up in the current turn, it won't until the next prompt.

**Suggested Fix:** Document this in the config schema docs. Not a blocker — it's how all pi resource discovery works (skills, extensions all require `/reload`).

---

### [P2] `headerText` in config is redundant with footer support

**File:** Config schema

**Issue:** The draft has `headerText` but no `footer`. Users who want full control over the injected text would need both. Also, `headerText` as a single string field doesn't compose well if the user wants the agent list between two paragraphs of instructions.

**Suggested Fix:** Use `header` and `footer` in the schema, both optional. The extension's built-in defaults provide sensible text:

```
Default header: "You are an orchestrator. Delegate specialized work to these sub-agents:"
Default footer: "Use the `subagent` tool with the `agent` parameter to delegate tasks."
```

If both are empty, inject only the agent list (minimal mode).

---

### [P2] No handling for agent files that parseAgentDefinition returns null for

**File:** `agent.ts:discoverAgentDefinitions()`

**Issue:** `discoverAgentDefinitions()` already filters out files where `parseAgentDefinition()` returns null (no valid frontmatter). This is correct behavior. But if ALL agent definitions fail to parse, the injected prompt should include a fallback message rather than silently injecting nothing or an empty list.

**Suggested Fix:** If the filtered agent list is empty, either skip injection entirely or inject a short note: "No sub-agents configured. Install agent .md files in ~/.pi/agent/agents/."

---

## What's Good

1. **Building blocks are already in place.** `discoverAgentDefinitions()` in `agent.ts` provides full agent metadata. `loadSubagentConfig()` in `config.ts` already merges global + project config. No new discovery or config infrastructure is needed.

2. **`before_agent_start` is the correct hook.** It fires once per user input, before the agent loop starts. It gives access to both `event.systemPrompt` (modifiable string) and `event.systemPromptOptions` (structured data about tools, skills, context files). The `prompt-customizer.ts` example in the pi SDK demonstrates the exact pattern needed.

3. **Token cost is well within budget.** Even in "standard" format with 10 agents, ~1K tokens on top of a system prompt that's typically 5-15K tokens. Compact format with 10 agents is ~400 tokens — negligible.

4. **The extension's module architecture is clean.** The existing pattern of using `Symbol.for()` for module-level state management (POLL_ABORT_KEY) shows awareness of the `/reload` lifecycle. The same pattern can extend to handle hook registration dedup.

5. **No tool blocking needed.** Unlike crew-of-pi which blocks write/edit tools for the orchestrator, this extension only injects a reminder. The AGENTS.md already documents "Orc does NOT edit files directly" — the prompt injection reinforces this without enforcing it. This is the right level of intervention for this project.

6. **The config file approach (global + project merge) already works.** `config.ts` has the merge pattern established. Adding `orchestratorPrompt` as a new top-level field in the same schema is straightforward.

---

## Recommended Config Schema

```typescript
interface OrchestratorPromptConfig {
  enabled: boolean;       // default: true
  format: "compact" | "standard";  // default: "compact"
  allowlist: string[];    // default: ["*"] (all agents)
  denylist: string[];     // default: []
  placement: "prepend" | "append"; // default: "append"
  maxAgents: number;      // default: 15, caps the list
  header: string;         // custom header (default: built-in)
  footer: string;         // custom footer (default: built-in)
}

// In subagent-config.json:
{
  "orchestratorPrompt": {
    "enabled": true,
    "format": "compact",
    "allowlist": ["*"],
    "denylist": [],
    "placement": "append",
    "maxAgents": 15,
    "header": "You are an orchestrator. Delegate work to available sub-agents:",
    "footer": "Use subagent with agent:<name> to delegate."
  },
  "agents": { /* existing per-agent overrides */ },
  "layout": "tiling"
}
```

Project config merges over global config (same as existing `agents` merge pattern in `loadSubagentConfig()`). If neither config exists, defaults apply (enabled with compact format).

---

## Recommended Prompt Format

### Compact (default)

```
## Available Sub-Agents

You are an orchestrator. Delegate specialized work to these sub-agents using the `subagent` tool:

- **Scout** — Fast codebase reconnaissance, maps existing code and patterns
- **Worker** — Implements features, fixes bugs, writes tests
- **Planner** — Interactive planning, requirements engineering, design
- **Reviewer** — Code review, quality analysis, security audit

<!-- subagent-orchestrator -->
```

(~30-50 tokens for 5 agents)

### Standard

```
## Available Sub-Agents

You are an orchestrator. Delegate specialized work to these sub-agents:

| Agent | Description | Tools | Model |
|-------|-------------|-------|-------|
| scout | Fast codebase reconnaissance | read, bash | claude-haiku-4-5 |
| worker | Feature implementation | read, bash, write, edit | claude-sonnet-4-5 |
| planner | Interactive planning | (inherits) | claude-opus-4-6 |
| reviewer | Code review | read, grep, ls | claude-sonnet-4-5 |

Use `subagent` tool with `agent: "<name>"` to delegate. Results arrive automatically as steer messages.

<!-- subagent-orchestrator -->
```

(~150-200 tokens for 5 agents)

---

## Edge Cases to Handle

1. **/reload double injection** → Use substring marker check (P0 fix)
2. **No agent files** → Skip injection silently
3. **All agents fail to parse** → Inject "No sub-agents available" note
4. **Allowlist empty** → Skip injection (user intentionally disabled all)
5. **Denylist = ["*"]** → Skip injection
6. **allowlist = ["nonexistent-agent"]** → All filtered out → skip injection
7. **More agents than maxAgents** → Show up to maxAgents, append "+N more"
8. **Config file malformed JSON** → `loadSubagentConfig()` returns null → use defaults
9. **Before agent_start returns { systemPrompt } but no message** → Test that the chained system prompt survives (it does — this is the documented pattern)
10. **Multiple pi sessions (fork/resume)** → `session_start` fires, next prompt hits `before_agent_start` → injection happens fresh. Correct behavior.

---

## Recommendations

1. **Implement the hook in a new file** `prompt-inject.ts` rather than adding to `index.ts`. This keeps the registration logic isolated and testable. `index.ts` would call `registerPromptInject(pi)`.

2. **Use `event.systemPromptOptions`** to detect agent capabilities (tools, skills, context files) rather than re-parsing. This is the documented purpose of `systemPromptOptions`.

3. **Cache the agent list** in a module-level variable. Re-discover only when `session_start` fires (or on `/reload`), not on every `before_agent_start` call. Agent definitions rarely change mid-session.

4. **Test pattern:** The `pi-extension/subagents/__test__` directory already exists. Add tests for:
   - `filtered agent list` — ensure correct allowlist/denylist logic
   - `format selection` — compact vs standard generates correct strings
   - `empty agent list` — graceful no-op
   - `marker dedup` — double call doesn't double-inject
   - `config merge` — project overrides global correctly

5. **Document the feature** in `docs/agents/orchestrator-prompt.md` or update AGENTS.md with the config schema and behavior.

6. **Register a `/subagent-inject` command** for debugging: shows what the hook would inject without actually modifying the system prompt.

---

## Comparison with crew-of-pi

| Aspect | crew-of-pi | This proposal |
|--------|-----------|---------------|
| Hook used | `before_agent_start` | `before_agent_start` |
| Blocks tools? | Yes (write, edit blocked) | No (soft reminder only) |
| Prompt content | Crew list + 12 delegation rules | Agent list + orchestration reminder |
| Configurable? | No | Yes (config file, format, allowlist/denylist) |
| Style | Aggressive — forces delegation | Gentle — reminds, doesn't enforce |
| `/reload` safe? | Unknown | Needs sentinel marker (P0 fix above) |
| Token cost | ~500-800 tokens (crew list + 12 rules) | ~200-500 tokens (compact) |

**Verdict:** Our approach is better for this project. The AGENTS.md already codifies "Orc does NOT edit files directly" at the contract level. The system prompt injection reinforces this without requiring tool blocking. Tool blocking would be a separate concern (opt-in feature for users who want enforcement).
