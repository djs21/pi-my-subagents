import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface AgentResourceOverride {
  extensions?: string[];
  skills?: string[];
  model?: string;
}

export interface SubagentConfig {
  agents: Record<string, AgentResourceOverride>;
}

function loadJsonConfig(filePath: string): SubagentConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SubagentConfig;
  } catch {
    return null;
  }
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
  return loadJsonConfig(getConfigPath(scope, cwd));
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
function loadSubagentConfig(cwd: string): SubagentConfig | null {
  const global = readSubagentConfig("global", cwd);
  const project = readSubagentConfig("project", cwd);

  if (!global && !project) return null;

  return {
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
