/**
 * Enforcement config builder — converts agent definitions into sub-agent CLI flags and env vars.
 *
 * Pure configuration functions with no I/O, no mux, no lifecycle.
 * Used by spin.ts and resume.ts to build --tools, PI_DENY_TOOLS, --model, etc.
 */
import { loadAgentDefaults } from "./agent.ts";
import type { AgentDefaults, SubagentSessionMode } from "./types.ts";
import { SPAWNING_TOOLS, SUBAGENT_CONTROL_TOOLS } from "./types.ts";
// config imported for consistency even if not used directly by these functions
import {} from "./config.ts";

// ─── resolveDenyTools ─────────────────────────────────────────────

export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      denied.add(t);
    }
  }
  return denied;
}

// ─── Session Resolution ─────────────────────────────────────────

export function resolveEffectiveSessionMode(params: { fork?: boolean }, agentDefs: AgentDefaults | null): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(params: { fork?: boolean }, agentDefs: AgentDefaults | null): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

export function resolveEffectiveInteractive(params: { interactive?: boolean }, agentDefs: AgentDefaults | null): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

// ─── Tool Allowlist ───────────────────────────────────────────────

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
  // ponytail: when no tools explicitly specified, default to safe minimal set
  // to prevent leaking parent agent's tools (including subagent spawning tools)
  if (requested.length === 0) {
    for (const tool of ["read", "bash"]) allow.add(tool);
  }
  return [...allow].join(",");
}

// ─── Prompt Args ──────────────────────────────────────────────────

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);
  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}
