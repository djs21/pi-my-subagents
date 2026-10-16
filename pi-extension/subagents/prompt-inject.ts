/**
 * System prompt injection for sub-agent orchestration.
 *
 * Registers a before_agent_start hook that injects a reminder about
 * available sub-agents into the system prompt every session.
 * Shows rich agent metadata (model, tools) and orchestration guidance.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgentDefinitions } from "./agent.ts";
import type { ListedAgentDefinition } from "./types.ts";
import { getMuxBackend } from "./mux.ts";
import { loadSubagentConfig } from "./config.ts";

const START = "<!-- subagent-orch-start -->";
const END = "<!-- subagent-orch-end -->";

const OODA_REMINDER = `### OODA Loop – Your Orchestration Discipline
Before every action (reading a file, writing, editing, spawning an agent, or running a bash command), you **must** mentally run through the OODA loop:
- **Observe**: Scan the battlefield (codebase). What's out there? What moves?
- **Orient**: Make sense of it. Where's the weakness? What's the true threat?
- **Decide**: Choose the strike. One clear blow, not a thousand wild swings.
- **Act**: Deploy your warband. Spawn sub-agents for scouting, fighting, or building. You stay back, watch, and adjust.
**Never skip** from Observe to Act without Decide. If uncertain, loop again: observe more, re-orient, re-decide.`;

const ORCHESTRATION_TOOLS = [
  "- `subagent_status` — check sub-agent progress. Returns a live snapshot immediately on every call; status changes also arrive automatically as steer messages — call when: user asked, suspected stall, or silent exit.",
  "- `subagent_peek` — inspect live terminal output of a running subagent pane (ANSI-stripped). Check progress without interrupting.",
  "- `subagent_steer` — inject live guidance or corrections directly into a running subagent pane. Set interrupt: true to cancel active turn first.",
  "- `subagent_interrupt` — send an interrupt signal to a running sub-agent.",
  "- `subagents_list` — list all active sub-agents.",
].join("\n");

const RESUME_CONVENTION = `### Resume-First Convention
When a sub-agent finishes (subagent_result steer with Session path), default to RESUMING its session for sequential work. Use \`subagent_resume(sessionPath: <path>, agent: "<next-agent>", message: "<instructions>")\` to continue with context.

Pass the \`agent\` param when you want the resumed session to adopt a specific agent definition (identity, model, session mode). Resumed sub-agents inherit all environment tools by default, so an omitted \`agent\` param no longer reduces their tool surface.

Typical chain: scout → resume as worker (findings in context) → resume as reviewer (code in context) → resume as worker (feedback in context).

Fresh spawn (subagent tool) only for:
- The first agent in a chain (no prior session)
- Tasks completely unrelated to any previous session
- Parallel sub-agents (to avoid cross-contamination)`;

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

function formatMultiplexerContext(): string {
  const backend = getMuxBackend();
  const callerPane = backend === "tmux" ? process.env.TMUX_PANE : backend === "herdr" ? process.env.HERDR_PANE_ID : undefined;
  const layout = loadSubagentConfig(process.cwd())?.layout ?? "tiling";

  const lines = [
    "### Multiplexer Environment",
    `- Backend: ${backend ? `**${backend}**` : "none (direct terminal)"}`,
    callerPane ? `- Orchestrator Pane: \`${callerPane}\`` : "",
    `- Pane Layout: \`${layout}\``,
    "- Live Monitoring & Steering: Use `subagent_peek` to inspect terminal output before deciding to steer or interrupt.",
  ].filter(Boolean);

  return lines.join("\n");
}

function formatAgentSection(agents: ListedAgentDefinition[]): string {
  const agentLines = agents.map(formatAgentLine).join("\n\n");

  const rules = [
    "### Guidance",
    "- You CAN write/edit/bash directly",
    "- For complex multi-file changes, delegate to Worker for isolation",
    "- For code review → Reviewer",
    ORCHESTRATION_TOOLS,
    formatMultiplexerContext(),
    OODA_REMINDER,
    RESUME_CONVENTION,
  ].join("\n");

  return [
    START,
    "## Available Sub-Agents",
    "",
    "You are an orchestrator. Delegate specialized work to these sub-agents using the `subagent` tool:",
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
