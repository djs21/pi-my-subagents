import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { LayoutType } from "./types.ts";

export interface AgentResourceOverride {
  extensions?: string[];
  tools?: string[];
  skills?: string[];
  model?: string;
}

export interface SubagentConfig {
  agents: Record<string, AgentResourceOverride>;
  layout?: LayoutType;
}


/**
 * Get config file path for a given scope.
 */
export function getConfigPath(scope: "project" | "global", cwd: string): string {
  if (scope === "global") {
    return join(homedir(), ".pi", "agent", "subagent-config.json");
  }
  return join(cwd, ".pi", "subagent-config.json");
}

/**
 * Read config for a specific scope only.
 */
export function readSubagentConfig(scope: "project" | "global", cwd: string): SubagentConfig | null {
  const filePath = getConfigPath(scope, cwd);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SubagentConfig;
  } catch (err: any) {
    console.warn(`[subagents] Warning: Failed to parse config file at ${filePath}: ${err?.message ?? String(err)}`);
    return null;
  }
}

/**
 * Write config to a specific scope.
 */
export function writeSubagentConfig(config: SubagentConfig, scope: "project" | "global", cwd: string): boolean {
  const filePath = getConfigPath(scope, cwd);
  try {
    writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Load subagent config from global + project locations.
 * Project overrides global.
 */
export function loadSubagentConfig(cwd: string): SubagentConfig | null {
  const global = readSubagentConfig("global", cwd);
  const project = readSubagentConfig("project", cwd);

  if (!global && !project) return null;

  return {
    layout: project?.layout ?? global?.layout ?? undefined,
    agents: {
      ...(global?.agents ?? {}),
      ...(project?.agents ?? {}),
    },
  };
}

/**
 * Get override config for a specific agent name.
 * Returns null if no override found.
 * JSON project > JSON global.
 */
export function getAgentOverride(cwd: string, agentName: string): AgentResourceOverride | null {
  const config = loadSubagentConfig(cwd);
  return config?.agents?.[agentName] ?? null;
}
