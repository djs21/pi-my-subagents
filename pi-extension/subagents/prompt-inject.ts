/**
 * System prompt injection for sub-agent orchestration.
 *
 * Registers a before_agent_start hook that injects a reminder about
 * available sub-agents into the system prompt every session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgentDefinitions } from "./agent.ts";
import type { ListedAgentDefinition } from "./types.ts";

const START = "<!-- subagent-orch-start -->";
const END = "<!-- subagent-orch-end -->";

export function registerPromptInject(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, _ctx) => {
    const agents = discoverAgentDefinitions();
    if (agents.length === 0) return;

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
  const lines = agents.map((a) => {
    const desc = a.description ? ` — ${a.description}` : "";
    return `- **${capitalize(a.name)}**${desc}`;
  });

  return [
    `${START}`,
    "## Available Sub-Agents",
    "",
    "You are an orchestrator. Delegate specialized work to these sub-agents using the `subagent` tool:",
    "",
    ...lines,
    "",
    `${END}`,
  ].join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
