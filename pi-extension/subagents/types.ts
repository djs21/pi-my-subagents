/**
 * Core types for the pi-my-subagent extension.
 * Pure type definitions — no runtime logic.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { SubagentActivityState } from "./activity.ts";
import type { SubagentStatusState } from "./status.ts";

// ─── Tool Parameter Schema ──────────────────────────────────────

export const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(Type.String({ description: "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills." })),
  systemPrompt: Type.Optional(Type.String({ description: "Appended to system prompt (role instructions)" })),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills (overrides agent default)" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tools (overrides agent default)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent" })),
  fork: Type.Optional(Type.Boolean({ description: "Force full-context fork mode" })),
  interactive: Type.Optional(Type.Boolean({ description: "Mark the subagent as interactive" })),
});

export type SubagentParamsType = Static<typeof SubagentParams>;

// ─── Subagent Session Mode ──────────────────────────────────────

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

// ─── Agent Defaults & Definitions ───────────────────────────────

export interface AgentDefaults {
  model?: string;
  tools?: string;
  extensions?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "package" | "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

// ─── Running Subagent ───────────────────────────────────────────

export interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  errorMessage?: string;
  ping?: { name: string; message: string };
}

export interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  statusState: SubagentStatusState;
  model?: string;
  interactive: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

export const SPAWNING_TOOLS = new Set(["subagent", "subagent_interrupt", "subagents_list", "subagent_resume"]);
// ─── Layout Type ────────────────────────────────────────────────

export type LayoutType = "tiling" | "bottom-stack" | "monocle";

export const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;
