/**
 * Subagent tool handler — spawn and resume logic.
 *
 * These are the execute/render functions for the `subagent` and
 * `subagent_resume` tools. They are extracted from the default export
 * in index.ts so the main module stays focused on wiring.
 *
 * Module-level state (latestCtx) is set via setLatestCtx() from the
 * session_start handler in index.ts.
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { keyHint, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { RunningSubagent, SubagentResult, SubagentParamsType } from "./types.ts";
import { SubagentParams, SPAWNING_TOOLS, SUBAGENT_CONTROL_TOOLS } from "./types.ts";
import {
  muxUnavailableResult,
  formatElapsed,
  getShellReadyDelayMs,
  getArtifactDir,
  resolveResumeLaunchBehavior,
} from "./agent.ts";
import {
  isMuxAvailable,
  createSurface,
  sendLongCommand,
  shellEscape,
} from "./mux.ts";
import {
  launchSubagent,
  watchSubagent,
  runningSubagents,
} from "./spawner.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  getSubagentActivityFile,
} from "./activity.ts";
import {
  updateWidget as widgetUpdateWidget,
  startWidgetRefresh as widgetStartWidgetRefresh,
  resolveResultPresentation,
} from "./widget.ts";
import { startStatusRefresh, observeRunningSubagent } from "./interrupt.ts";
import { createStatusState, loadStatusConfig } from "./status.ts";

// ─── Module-level state ─────────────────────────────────────────

let latestCtx: any = null;

export function setLatestCtx(ctx: any) {
  latestCtx = ctx;
}

const statusConfig = loadStatusConfig();

// ─── Internal helpers ───────────────────────────────────────────

export function updateWidget() {
  widgetUpdateWidget(latestCtx, runningSubagents, statusConfig.enabled);
}

export function startWidgetRefresh() {
  widgetStartWidgetRefresh(latestCtx, runningSubagents, statusConfig.enabled);
}

// ─── subagent tool ──────────────────────────────────────────────

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

// ─── subagent_resume tool ──────────────────────────────────────

export async function executeSubagentResume(
  _toolCallId: string,
  params: any,
  _signal: AbortSignal,
  _onUpdate: any,
  ctx: any,
  pi: ExtensionAPI,
) {
  const name = params.name ?? "Resume";
  const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  if (!isMuxAvailable()) return muxUnavailableResult();
  if (!existsSync(params.sessionPath)) {
    return { content: [{ type: "text", text: `Error: session file not found: ${params.sessionPath}` }], details: { error: "session not found" } };
  }

  const entryCountBefore = getNewEntries(params.sessionPath, 0).length;
  const surface = createSurface(name);
  await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

  const parts = ["pi", "--session", shellEscape(params.sessionPath)];
  const subagentDonePath = join(import.meta.dirname, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  let resumeMsgFile: string | undefined;
  if (params.message) {
    const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    resumeMsgFile = join(artifactDir, "subagent-resume", `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`);
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, params.message, "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  const resumeEnvParts: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR) resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
  resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
  resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  if (autoExit) resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

  const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [`# Subagent resume script for ${name}`, `# Generated: ${new Date().toISOString()}`, `# Session: ${params.sessionPath}`, `# Surface: ${surface}`, ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : [])].join("\n"),
  });

  const running: RunningSubagent = { id, name, task: params.message ?? "resumed session", surface, startTime, sessionFile: params.sessionPath, launchScriptFile, activityFile, interactive, statusState: createStatusState({ source: "pi", startTimeMs: startTime }) };
  runningSubagents.set(id, running);
  startWidgetRefresh();
  startStatusRefresh(pi, statusConfig, runningSubagents, updateWidget);

  const watcherAbort = new AbortController();
  running.abortController = watcherAbort;

  watchSubagent(running, watcherAbort.signal, observeRunningSubagent)
    .then((result) => {
      updateWidget();

      if (result.ping) {
        const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
        pi.sendMessage(
          { customType: "subagent_ping", content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`, display: true, details: { name: result.ping.name, message: result.ping.message, sessionFile: params.sessionPath } },
          { triggerTurn: true, deliverAs: "steer" },
        );
        return;
      }

      const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
      const summary = findLastAssistantMessage(allEntries) ?? (result.errorMessage ? `Subagent error: ${result.errorMessage}` : result.exitCode !== 0 ? `Resumed session exited with code ${result.exitCode}` : "Resumed session exited without new output");
      const presentation = resolveResultPresentation({ ...result, summary, sessionFile: params.sessionPath }, name);

      pi.sendMessage(
        { customType: "subagent_result", content: presentation, display: true, details: { name, task: params.message ?? "resumed session", exitCode: result.exitCode, elapsed: result.elapsed, sessionFile: params.sessionPath, ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}) } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    })
    .catch((err) => {
      updateWidget();
      pi.sendMessage(
        { customType: "subagent_result", content: `Resume error: ${err?.message ?? String(err)}`, display: true, details: { name, error: err?.message } },
        { triggerTurn: true, deliverAs: "steer" },
      );
    });

  return { content: [{ type: "text", text: `Session "${name}" resumed.` }], details: { id, name, sessionPath: params.sessionPath, launchScriptFile, status: "started" } };
}

export function renderSubagentResumeCall(args: any, theme: any) {
  const name = args.name ?? "Resume";
  return new Text("▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"), 0, 0);
}

export function renderSubagentResumeResult(result: any, _opts: any, theme: any) {
  const details = result.details as any;
  const name = details?.name ?? "Resume";
  if (details?.status === "started") {
    return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resumed"), 0, 0);
  }
  const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
  return new Text(theme.fg("dim", text), 0, 0);
}

// ─── Tool definition factories ────────────────────────────────

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

export function createSubagentResumeTool(pi: ExtensionAPI) {
  return {
    name: "subagent_resume",
    label: "Resume Subagent",
    description:
      "Resume a previous sub-agent session in a new multiplexer pane. " +
      "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
      "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
      "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
      "Use when a sub-agent was cancelled or needs follow-up work.",
    promptSnippet:
      "Resume a previous sub-agent session in a new multiplexer pane. " +
      "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
      "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
      "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
      "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
      "Use when a sub-agent was cancelled or needs follow-up work.",
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
      name: Type.Optional(Type.String({ description: "Display name for the terminal tab. Default: 'Resolve'" })),
      message: Type.Optional(Type.String({ description: "Optional message to send after resuming (e.g. follow-up instructions)" })),
      autoExit: Type.Optional(Type.Boolean({ description: "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions." })),
    }),
    execute: (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) =>
      executeSubagentResume(id, params, signal, onUpdate, ctx, pi),
    renderCall: renderSubagentResumeCall,
    renderResult: renderSubagentResumeResult,
  };
}
