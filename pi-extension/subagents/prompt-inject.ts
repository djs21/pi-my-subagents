/**
 * System prompt injection for sub-agent orchestration.
 *
 * Registers a before_agent_start hook that injects a reminder about
 * available sub-agents into the system prompt every session.
 * Shows rich agent metadata (model, tools) and conditional rules
 * based on delegate mode (ON = blocked from write/edit).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgentDefinitions } from "./agent.ts";
import type { ListedAgentDefinition } from "./types.ts";

const START = "<!-- subagent-orch-start -->";
const END = "<!-- subagent-orch-end -->";

interface DelegateConfig {
  enabled: boolean;
}

function getDelegateConfig(): DelegateConfig {
  try {
    const configPath = join(homedir(), ".pi", "agent", "subagent-config-main.json");
    if (!existsSync(configPath)) return { enabled: false };
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as DelegateConfig;
  } catch {
    return { enabled: false };
  }
}

function formatAgentLine(a: ListedAgentDefinition): string {
  const desc = a.description ? ` — ${a.description}` : "";
  const model = a.model ? ` | model: ${a.model}` : "";
  const tools = a.tools ? ` | tools: ${a.tools}` : "";
  return `### ${capitalize(a.name)}${desc}\n  ${model}${tools}`;
}

export function registerPromptInject(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, _ctx) => {
    const agents = discoverAgentDefinitions();
    if (agents.length === 0) return;
    // Skip injection for sub-agents — only main orchestrator needs this
    if (process.env.PI_SUBAGENT_NAME) return;

    const section = formatAgentSection(agents);
    const { systemPrompt } = event;

    // Replace existing section if found (survives /reload), otherwise append
    const startIdx = systemPrompt.indexOf(START);
    const endIdx = systemPrompt.indexOf(END);

    let newPrompt: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      newPrompt = systemPrompt.slice(0, startIdx) + section + systemPrompt.slice(endIdx + END.length);
    } else {
      newPrompt = systemPrompt + "\n\n" + section;
    }

    return {
      systemPrompt: newPrompt,
    };
  });
}

function formatAgentSection(agents: ListedAgentDefinition[]): string {
  const delegateConfig = getDelegateConfig();
  const agentLines = agents.map(formatAgentLine).join("\n\n");

  const rules = delegateConfig.enabled
    ? [
        "### Rules",
        "- You CAN read/grep/bash to explore the codebase",
        "- You CANNOT write/edit — blocked. Delegate to Worker.",
        "- For code review → Reviewer",
        "- Always pass `agent` param matching the name",
        "- Multiple Workers can run in parallel",
      ].join("\n")
    : [
        "### Guidance",
        "- You CAN write/edit/bash directly",
        "- For complex multi-file changes, delegate to Worker for isolation",
        "- For code review → Reviewer",
      ].join("\n");

  return [
    START,
    "## Available Sub-Agents",
    "",
    delegateConfig.enabled
      ? "Delegate via the `subagent` tool."
      : "You are an orchestrator. Delegate specialized work to these sub-agents using the `subagent` tool:",
    "",
    agentLines,
    "",
    rules,
    "",
    END,
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
