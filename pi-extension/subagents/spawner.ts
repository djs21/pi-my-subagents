/**
 * Subagent launch and watch lifecycle.
 * Handles spawning a subagent in a mux pane and watching it until completion.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { RunningSubagent, SubagentResult, AgentDefaults } from "./types.ts";
import {
  loadAgentDefaults,
  resolveDenyTools,
  resolveSubagentPaths,
  getDefaultSessionDirFor,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  getArtifactDir,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  getShellReadyDelayMs,
} from "./agent.ts";
import {
  createSurface,
  renameSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreenAsync,
  getMuxBackend,
} from "./mux.ts";
import {
  seedSubagentSessionFile,
  getNewEntries,
  findLastAssistantMessage,
} from "./session.ts";
import {
  getSubagentActivityFile,
} from "./activity.ts";
import { createStatusState } from "./status.ts";

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Spawner State ──────────────────────────────────────────────

const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

/** All currently running subagents, keyed by id. */
export const runningSubagents = new Map<string, RunningSubagent>();

// ─── launchSubagent ─────────────────────────────────────────────

export async function launchSubagent(
  params: any,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  // Auto-resolve agent: explicit params.agent wins (case-any), else try name as fallback
  const agentName = params.agent ?? params.name;
  const agentDefs = agentName ? loadAgentDefaults(agentName.toLowerCase()) : null;
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

  if (!surfacePreCreated) {
    const backend = getMuxBackend();
    if (backend === "herdr") {
      // Herdr: pane run executes directly — no readiness race
    } else {
      // Tmux: shell readiness polling via marker
      const timeoutMs = getShellReadyDelayMs();
      const readyMarker = `__SUBAGENT_READY_${Date.now()}__`;
      try {
        sendCommand(surface, `echo '${readyMarker}'`);
        const deadline = Date.now() + timeoutMs;
        let ready = false;
        while (Date.now() < deadline) {
          const screen = await readScreenAsync(surface, 20);
          if (screen.includes(readyMarker)) { ready = true; break; }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) {
          console.warn(`[subagents] Shell readiness timeout for pane ${surface} after ${timeoutMs}ms, proceeding anyway`);
        }
      } catch (err) {
        console.warn(`[subagents] Shell readiness polling failed for pane ${surface}: ${err}, proceeding anyway`);
      }
    }
  }

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
    ? "Complete your task autonomously. If stuck, need clarification, or need the parent to take action, use the caller_ping tool to send a help request."
    : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time. If stuck, need clarification, or need the parent to take action, use the caller_ping tool to send a help request.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before calling subagent_done, caller_ping, or before the user exits) should summarize what you accomplished.";
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

  // Sub-agents don't need skill definitions unless explicitly requested via frontmatter
  if (!agentDefs?.skills) {
    parts.push("--no-skills");
  }

  // Per-agent exclusive extensions & skills
  if (agentDefs) {
    const { buildAgentResourceArgs } = await import("./agent.ts");
    const resourceArgs = buildAgentResourceArgs(agentDefs, effectiveAgentDir);
    parts.push(...resourceArgs);
  }

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

// ─── watchSubagent ──────────────────────────────────────────────

export async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
  onObserve: (running: RunningSubagent) => void,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      onTick() {
        onObserve(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage ? `Subagent error: ${result.errorMessage}` : result.exitCode !== 0 ? `Sub-agent exited with code ${result.exitCode}` : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage ? `Subagent error: ${result.errorMessage}` : result.exitCode !== 0 ? `Sub-agent exited with code ${result.exitCode}` : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name, task, summary, sessionFile,
      exitCode: result.exitCode, elapsed,
      ping: result.ping,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    try { closeSurface(surface); } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return { name, task, summary: "Subagent cancelled.", exitCode: 1, elapsed: Math.floor((Date.now() - startTime) / 1000), error: "cancelled", sessionFile };
    }
    return { name, task, summary: `Subagent error: ${err?.message ?? String(err)}`, exitCode: 1, elapsed: Math.floor((Date.now() - startTime) / 1000), error: err?.message ?? String(err) };
  }
}
