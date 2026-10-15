/**
 * Enforcement config builder — converts agent definitions into sub-agent CLI flags and env vars.
 *
 * Pure configuration functions with no I/O, no mux, no lifecycle.
 * Used by spin.ts and resume.ts to build --tools, PI_DENY_TOOLS, --model, etc.
 */
import { loadAgentDefaults } from "./agent.ts";
import type { AgentDefaults, SubagentSessionMode } from "./types.ts";
import { ORCHESTRATOR_TOOLS, SUBAGENT_CONTROL_TOOLS } from "./types.ts";
// config imported for consistency even if not used directly by these functions
import {} from "./config.ts";

// ─── resolveDenyTools ─────────────────────────────────────────────

/**
 * Build the set of tools that must be denied in a child sub-agent session.
 *
 * Always includes the orchestrator tools (subagent, subagent_resume,
 * subagent_interrupt, subagent_status, subagents_list) so a child can never
 * spawn or manage siblings. Additional denials come from the agent's
 * `deny-tools` frontmatter and any merged project/global config overrides.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  for (const t of ORCHESTRATOR_TOOLS) denied.add(t);
  if (!agentDefs) return denied;
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      denied.add(t);
    }
  }
  return denied;
}
export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
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

/**
 * Build the `--tools` allowlist for a child sub-agent session.
 *
 * New model: sub-agents inherit ALL tools available in the parent Pi
 * environment by default (including tools from other extensions). We only
 * emit an explicit allowlist when the agent/params explicitly configure
 * tools. When no tools are configured, this returns `null` so the child
 * keeps the full inherited tool surface.
 *
 * Orchestrator tools are never added here; they are excluded via the deny
 * path (`resolveDenyTools` → `--exclude-tools` / `PI_DENY_TOOLS`).
 */
export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (requested.length === 0) return null;
  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
  return [...allow].join(",");
}

// ─── Tool Denylist Args ───────────────────────────────────────────

/**
 * Build the pi CLI denylist arguments for a child session.
 *
 * Emits `--exclude-tools <comma-separated>` when any tools are denied. The
 * deny set always includes the orchestrator tools plus frontmatter/config
 * `deny-tools`. This is the CLI-level counterpart to the `PI_DENY_TOOLS`
 * env var (which the subagent extension itself reads to skip registration).
 */
export function buildSubagentToolDenyArgs(denyTools: Set<string>): string[] {
  if (denyTools.size === 0) return [];
  return ["--exclude-tools", [...denyTools].join(",")];
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
