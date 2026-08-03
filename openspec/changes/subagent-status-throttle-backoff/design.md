## Context

The `subagent_status` throttle in `shared.ts` enforces a 30s minimum interval. When throttled, `index.ts` returns a notice with retry time and last-known status (from the previous change). However, persistent models ignore the notice and keep polling every 5-6s — each call returns the same "next check in Ns" text. The model doesn't learn because the penalty never escalates.

## Goals / Non-Goals

**Goals:**
- Consecutive throttled calls double the cooldown (30s → 60s → 120s → 240s cap)
- Polling becomes counterproductive — each attempt extends the model's own wait
- Notice text shows the penalty so the model understands why the window grew
- Reset on spawn so first check after launch is always allowed

**Non-Goals:**
- Changing the steer system or dynamic tool deregistration
- Error-return or tool removal for excessive polling
- Changing base interval logic or config schema
- Persisting strikes across process restarts

## Decisions

**1. Module-level `throttleStrikes` counter (same pattern as `lastStatusCheckAt`)**
Module-level state is naturally per-session per-process. No isolation needed. Follows existing pattern — `lastStatusCheckAt` is already module-level. Rationale: shared.ts is the natural home for cross-module state.

**2. `effectiveInterval()` helper with `2^min(strikes, MAX_THROTTLE_STRIKES)` cap**
Clean formula, one function. Cap at 3 strikes → 2^3 = 8x → 8 * 30s = 240s (4 min). Bounded so legitimately anxious model doesn't get locked out forever. Rationale: explicit cap prevents runaway.

**3. Strikes++ before returning false in `checkStatusThrottle()`**
Incrementing strikes before returning false means the notice computed right after shows the inflated (penalty) window. The model sees its own punishment immediately. Rationale: feedback loop requires the model to see the consequence of its previous call.

**4. `getStatusThrottleStrikes()` export for notice wording**
index.ts needs to know the strike count to append "Repeated polling extends the cooldown." Export keeps shared.ts as the single source of truth. Rationale: index.ts should not reach into module-level state.

**5. Reset on spawn via `resetStatusCheckThrottle()` (existing function, add `throttleStrikes = 0`)**
New subagent = fresh start. Model should be able to confirm the subagent started. One line added to existing function. Rationale: follows existing reset pattern.

## Risks / Trade-offs

- **Legitimately anxious model gets longer lockout** → Bounded at 4-min cap (8x base, MAX_THROTTLE_STRIKES=3), resets on spawn. Notice text explains why.
- **Notice text adds tokens** → Minimal: " Repeated polling extends the cooldown." is ~6 words.
- **Strikes leak across subagents** → Module-level state, same session. If model polls during agent A, then spawns agent B, B gets inherited strikes. Mitigated by reset on spawn.

## Additional Design Notes

- **`getStatusThrottleRemainingMs()` guard**: Returns 0 immediately if `lastStatusCheckAt === 0` (never checked yet), avoiding negative-elapsed arithmetic.
- **resume.ts does not call `resetStatusCheckThrottle`** — only fresh spawns (`spin.ts:launchSubagent`) reset the backoff. Resume reuses the existing session's throttle state.
