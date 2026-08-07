# Code Review

**Reviewed:** OpenSpec proposal "orchestration-tools-nudge" — prompt injection update for orchestration tools
**Verdict:** NEEDS CHANGES (one P1, plus two P2 items worth addressing)

## Summary

The proposal is well-scoped and sound in structure: extract four tool descriptions into a shared `ORCHESTRATION_TOOLS` const, replace the stale single-line `subagent_status` mention in both delegate paths, and add tests. The codebase analysis confirms the backoff constants, tool registrations, and injection plumbing all match the spec's claims. Two P1 issues need attention before implementation.

## Findings

### [P1] Tool description contradicts new prompt text
**File:** `pi-extension/subagents/index.ts:282-284`
**Issue:** The `subagent_status` tool's `description` field says:

> "RATE LIMITED: max once per 30s — calling more often returns a throttle notice..."

The new prompt injection text (per spec) will describe the exponential backoff: 30s→60s→120s→240s, repeated polling extends cooldown. Both go into the model's context — the prompt injection via `before_agent_start` and the tool description via the tool schema sent to the model. These will contradict each other.

The same stale wording appears in `promptSnippet` at lines 288 ("Rate limited to max once per 30s").

**Suggested Fix:** Update the tool `description` and `promptSnippet` in `index.ts:282-290` to match the new prompt wording, e.g. "RATE LIMITED with exponential backoff (30s→60s→120s→240s). Repeated polling extends the cooldown. Status changes auto-delivered as steers."

The design.md Non-Goals says "no runtime tool behavior changes" — this is a *wording* change, not a behavior change. It's documentation consistency, not a non-goal violation.

### [P1] Delegate-OFF spec scenario is untestable as written
**File:** `specs/orchestration-tools-nudge/spec.md:12-14`
**Issue:** The spec requires:

> **WHEN** `registerPromptInject` fires with delegate config disabled
> **THEN** the injected section SHALL contain ...

But the delegate config is read from the real filesystem (`~/.pi/agent/subagent-config-main.json`) via `getDelegateConfig()` in `prompt-inject.ts:24-33`. The test approach (capturing `before_agent_start` callback, invoking with fake event) cannot control which delegate branch fires — it depends on the test runner's filesystem state.

**Mitigation:** Decision 1 (shared `ORCHESTRATION_TOOLS` const referenced by both paths) means testing one path implicitly validates the other. The spec scenario is technically satisfied by construction, even though a direct test can't toggle it.

**Suggested Fix:** Either: (a) document in the spec that this is verified by construction (shared const), not by separate test; or (b) extract `getDelegateConfig` behind a DI seam so tests can inject it. Option (a) is simpler and consistent with the "lazy" design principle.

### [P2] `send_messages` is dead in the gap between slice A and slice B
**File:** `proposal.md:26` (Impact section)
**Issue:** Slice A injects `send_messages` into the prompt. Slice B registers the tool. Between A landing and B landing, the model will see a prompt telling it `send_messages` exists, will try to call it, and will get tool-not-found errors. The proposal acknowledges this as a dependency but doesn't propose a mitigation.

**Suggested Fix:** Land both slices in close succession (same merge session), or add a feature flag so `send_messages` only appears in the prompt when the tool is actually registered. The proposal already flags this under Risks/Trade-offs, so this is more of a process note — just don't let A sit on main for days without B.

### [P2] Token estimate may be slightly high but acceptable
**File:** `proposal.md:25`
**Issue:** The proposal estimates "~100 tokens." With four single-line tool descriptions (each ~8-15 words), actual increase is closer to 50-70 tokens. This is cosmetic — both numbers are fine for per-session injection. Not blocking.

## What's Good

- **Design Decision 1 (shared const)** is correct. Both delegate paths currently inline identical `subagent_status` text (lines 81 and 88 of prompt-inject.ts). Extracting into a const eliminates drift risk.
- **Backoff constants verified.** `shared.ts:49-53` — `MAX_THROTTLE_STRIKES=3`, `effectiveInterval() = minIntervalMs * 2^strikes` capped at strike 3. Default 30s produces 30→60→120→240, matching the spec's claimed behavior.
- **All four tools exist** at the claimed locations: `subagent_interrupt` (index.ts:174), `subagents_list` (index.ts:224), `subagent_status` (index.ts:277). `send_messages` is confirmed in the companion proposal.
- **Injection plumbing confirmed.** `START`/`END` markers at lines 17-18, replacement logic at 52-61, `formatAgentSection` at 69-105 — all match spec claims.
- **Test approach is sound.** Extending the existing `createMockExtensionApi()` mock to capture `on()` callbacks is minimal and follows existing patterns. No conflicting test infra.
- **tasks.md scope is correct.** All tasks stay within `prompt-inject.ts` + `test/test.ts`. Sequential structure makes sense (1. code, 2. test, 3. validate).
- **Spec is complete and testable** (modulo the P1 delegate-OFF scenario noted above). Scenarios cover both paths, backoff wording, marker replacement, and path-identical content.

## Pre-existing Issues (not blocking, noted for awareness)

- `test/test.ts:1834` — `subagent_interrupt` registration test fails: `registeredTools.some(...)` returns false. This is a pre-existing test failure unrelated to this proposal.
