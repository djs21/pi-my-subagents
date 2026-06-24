import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, existsSync } from "node:fs";

interface AgentResourceOverride {
  extensions?: string[];
  skills?: string[];
  model?: string;
}

interface SubagentConfig {
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
 * Load subagent config from global + project locations.
 * Project overrides global.
 */
function loadSubagentConfig(cwd: string): SubagentConfig | null {
  const globalPath = join(homedir(), ".pi", "agent", "subagent-config.json");
  const projectPath = join(cwd, ".pi", "subagent-config.json");

  const global = loadJsonConfig(globalPath);
  const project = loadJsonConfig(projectPath);

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