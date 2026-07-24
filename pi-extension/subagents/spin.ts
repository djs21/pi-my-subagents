/**
 * Subagent spawn lifecycle — launch, execute, render, tool creator.
 *
 * Owns the complete flow for spawning a new sub-agent:
 *   enforce config (via enforce.ts) → surface (via mux.ts) → readiness (via shared.ts)
 *   → seed session → build pi command → launch → return RunningSubagent.
 *
 * Also exports the execute/render/tool-factory for the `subagent` tool.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { RunningSubagent, SubagentResult, SubagentParamsType } from "./types.ts";
import { SubagentParams } from "./types.ts";
import {
  loadAgentDefaults,
  resolveAgentByPrefix,
  resolveSubagentPaths,
  getDefaultSessionDirFor,
  getArtifactDir,
  formatElapsed,
  muxUnavailableResult,
} from "./agent.ts";
import {
  resolveDenyTools,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
} from "./enforce.ts";
import {
  surfaceReadiness,
  watchSubagent,
  runningSubagents,
  updateWidget,
  startWidgetRefresh,
} from "./shared.ts";
import {
  isMuxAvailable,
  createSurface,
  renameSurface,
  sendCommand,
  sendLongCommand,
  shellEscape,
} from "./mux.ts";
import {
  seedSubagentSessionFile,
} from "./session.ts";
import {
  getSubagentActivityFile,
} from "./activity.ts";
import { createStatusState, loadStatusConfig } from "./status.ts";
import { startStatusRefresh, observeRunningSubagent } from "./interrupt.ts";
import { resolveResultPresentation } from "./widget.ts";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Module-level state ─────────────────────────────────────────

const statusConfig = loadStatusConfig();

// ─── launchSubagent ─────────────────────────────────────────────

export async function launchSubagent(
  params: any,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  // Coordination dir for incoming messages from orchestrator
  const coordDir = join(process.env.HOME || "/tmp", ".local", "share", "pi", "subagents", id);
  mkdirSync(join(coordDir, "incoming"), { recursive: true });
  // Auto-resolve agent: explicit params.agent wins (case-any), else try name as fallback
  // If exact name doesn't match an agent definition, try prefix matching
  // Final fallback: worker defaults (common case, better than crippled agent)
  const agentName = params.agent ?? params.name;
  const agentDefs = agentName
    ? (loadAgentDefaults(agentName.toLowerCase()) ?? resolveAgentByPrefix(agentName.toLowerCase()) ?? loadAgentDefaults("worker"))
    : loadAgentDefaults("worker");
  const resolvedAgent = agentDefs?.name ?? params.agent; // track which agent actually resolved
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [id, Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 6)].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);

  // Label the pane with agent:name format (best-effort)
  const label = [params.agent, params.name].filter(Boolean).join(": ");
  renameSurface(surface, label);

  // Wait for shell readiness (shared helper — replaces inline polling)
  await surfaceReadiness(surface, { skip: surfacePreCreated });

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  const modeHint = agentDefs?.autoExit
    ? `Complete your task autonomously. If stuck, need clarification, or need the parent to take action, use the caller_ping tool to send a help request. Periodically call check_messages() to see if the orchestrator has sent new instructions or ideas.`
    : `Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time. If stuck, need clarification, or need the parent to take action, use the caller_ping tool to send a help request. Periodically call check_messages() to see if the orchestrator has sent new instructions or ideas.`;
  const summaryInstruction = agentDefs?.autoExit
    ? "IMPORTANT: Before calling subagent_done, your assistant message MUST include a TEXT block that summarizes what you accomplished. Do NOT skip this — the orchestrator uses it as your completion report. A tool call alone (like write or subagent_done) does NOT count as a summary."
    : "IMPORTANT: Before calling subagent_done, caller_ping, or before the user exits, your assistant message MUST include a TEXT block that summarizes what you accomplished. Do NOT skip this — the orchestrator uses it as your completion report. A tool call alone does NOT count as a summary.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext
    ? params.task
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  // ── Pi CLI path ──
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  if (identityInSystemPrompt && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push(flag, shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) parts.push("--tools", shellEscape(toolAllowlist));

  // Worker and visual-tester don't need project context files (AGENTS.md, CLAUDE.md)
  // Scout, planner, and reviewer need AGENTS.md for codebase mapping
  if (agentDefs?.name === "worker" || agentDefs?.name === "visual-tester") {
    parts.push("--no-context-files");
  }

  // Sub-agents don't need skill definitions — default skills suppressed.
  // Skills are loaded via /skill:name prompt args (buildPiPromptArgs) or pi's internal
  // skill resolution from subagent-config.json, not via --skill CLI flag.
  parts.push("--no-skills");



  const envParts: string[] = [];
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }
  if (denySet.size > 0) envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  if (agentDefs?.autoExit) envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_COORD_DIR=${shellEscape(coordDir)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "subagent";
    const artifactPath = join(artifactDir, `context/${safeName}-${ts}.md`);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({ effectiveSkills, taskDelivery: launchBehavior.taskDelivery, taskArg })) {
    parts.push(shellEscape(promptArg));
  }

  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const nonce = Math.random().toString(16).slice(2, 10);
  const sentinelPath = shellEscape(`${subagentSessionFile}.sentinel`);
  const command = `echo '__SUBAGENT_DONE_START_${nonce}__'; ${piCommand}; __PI_SENTINEL_EXIT__=$?; echo '__SUBAGENT_DONE_END_'$__PI_SENTINEL_EXIT__'_${nonce}__'; echo "$__PI_SENTINEL_EXIT__" > ${sentinelPath}`;
  const launchScriptName = `${(params.name || "subagent").toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id, name: params.name, task: params.task, agent: resolvedAgent,
    surface, startTime, sessionFile: subagentSessionFile,
    launchScriptFile, activityFile,
    model: effectiveModel,
    interactive: effectiveInteractive,
    statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
  };

  runningSubagents.set(id, running);
  return running;
}

// ─── subagent tool handler ──────────────────────────────────────

export async function executeSubagentTool(
  _toolCallId: string,
  params: any,
  _signal: AbortSignal,
  _onUpdate: any,
  ctx: any,
  pi: ExtensionAPI,
) {
  // Prevent self-spawning (check agent param first, then name as fallback)
  const currentAgent = process.env.PI_SUBAGENT_AGENT;
  const spawnAgent = params.agent ?? params.name;
  if (spawnAgent && currentAgent && spawnAgent.toLowerCase() === currentAgent.toLowerCase()) {
    return {
      content: [{ type: "text", text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.` }],
      details: { error: "self-spawn blocked" },
    };
  }

  if (!isMuxAvailable()) return muxUnavailableResult();
  if (!ctx.sessionManager.getSessionFile()) {
    return { content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }], details: { error: "no session file" } };
  }

  const running = await launchSubagent(params, ctx);
  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  startWidgetRefresh();
  startStatusRefresh(pi, statusConfig, runningSubagents, updateWidget);

  watchSubagent(running, watcherAbort.signal, observeRunningSubagent)
    .then((result) => {
      updateWidget();

      if (result.ping) {
        const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
        pi.sendMessage(
          { customType: "subagent_ping", content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`, display: true, details: { name: result.ping.name, message: result.ping.message, agent: running.agent, sessionFile: result.sessionFile } },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }

      const presentation = resolveResultPresentation(result, running.name);
      pi.sendMessage(
        { customType: "subagent_result", content: presentation, display: true, details: { name: running.name, task: running.task, agent: running.agent, exitCode: result.exitCode, elapsed: result.elapsed, sessionFile: result.sessionFile, ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}) } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      updateWidget();
      pi.sendMessage(
        { customType: "subagent_result", content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`, display: true, details: { name: running.name, task: running.task, error: err?.message } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

  return {
    content: [{ type: "text", text: `Sub-agent "${params.name}" launched and is now running in the background. Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. The results will be delivered to you automatically as a steer message when the sub-agent finishes. Until then, move on to other work or tell the user you're waiting.` }],
    details: { id: running.id, name: params.name, task: params.task, agent: params.agent, sessionFile: running.sessionFile, launchScriptFile: running.launchScriptFile, status: "started" },
  };
}

// ─── Render functions ───────────────────────────────────────────

export function renderSubagentCall(args: any, theme: any) {
  const partialArgs = args as Record<string, unknown>;
  const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
  const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
  const agent = typeof partialArgs.agent === "string" && partialArgs.agent ? theme.fg("dim", ` (${partialArgs.agent})`) : "";
  const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd ? theme.fg("dim", ` in ${partialArgs.cwd}`) : "";
  let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

  if (task) {
    const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
    const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
    if (preview) text += "\n" + theme.fg("toolOutput", preview);
    const totalLines = task.split("\n").length;
    if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
  }

  return new Text(text, 0, 0);
}

export function renderSubagentResult(result: any, _opts: any, theme: any) {
  const details = result.details as any;
  const name = details?.name ?? "(unnamed)";

  if (details?.status === "started") {
    return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — started"), 0, 0);
  }

  const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
  return new Text(theme.fg("dim", text), 0, 0);
}

// ─── Tool definition factory ────────────────────────────────────

export function createSubagentTool(pi: ExtensionAPI) {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
      "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
      "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
      "DO NOT fabricate, assume, or summarize results after calling this tool. " +
      "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
    promptSnippet:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
      "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
      "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
      "DO NOT fabricate, assume, or summarize results after calling this tool. " +
      "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
    parameters: SubagentParams,
    execute: (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) =>
      executeSubagentTool(id, params, signal, onUpdate, ctx, pi),
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,
  };
}
