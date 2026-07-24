/**
 * Sub-agent resume lifecycle — resuming an existing session in a new mux pane.
 *
 * This module contains the full lifecycle for resuming a sub-agent session:
 * loading enforcement config from enforce.ts (fixes P1), creating mux surface
 * (using shared.ts readiness), building pi command with --session, and
 * returning a RunningSubagent.
 *
 * Exports: executeSubagentResume, createSubagentResumeTool,
 *          renderSubagentResumeCall, renderSubagentResumeResult,
 *          resolveResumeLaunchBehavior
 */

import { Text } from "@earendil-works/pi-tui";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { RunningSubagent } from "./types.ts";
import {
  buildSubagentToolAllowlist,
  resolveDenyTools,
} from "./enforce.ts";
import {
  surfaceReadiness,
  watchSubagent,
  runningSubagents,
  updateWidget,
  startWidgetRefresh,
} from "./shared.ts";
import {
  loadAgentDefaults,
  getArtifactDir,
  formatElapsed,
  muxUnavailableResult,
} from "./agent.ts";
import {
  isMuxAvailable,
  createSurface,
  sendLongCommand,
  shellEscape,
} from "./mux.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
} from "./session.ts";
import {
  getSubagentActivityFile,
} from "./activity.ts";
import {
  createStatusState,
  loadStatusConfig,
} from "./status.ts";
import {
  startStatusRefresh,
  observeRunningSubagent,
} from "./interrupt.ts";
import {
  resolveResultPresentation,
} from "./widget.ts";

// ─── Module-level state ─────────────────────────────────────────

const statusConfig = loadStatusConfig();

// ─── resolveResumeLaunchBehavior ─────────────────────────────────

export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

// ─── executeSubagentResume ───────────────────────────────────────

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

  // Use shared surfaceReadiness instead of inline polling
  await surfaceReadiness(surface, { label: "resume" });

  const parts = ["pi", "--session", shellEscape(params.sessionPath)];
  const subagentDonePath = join(import.meta.dirname, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });

  // ── Enforcement (P1 fix) ─────────────────────────────────────
  // Load agent defaults if an agent was specified, for tool enforcement
  let agentDefs = null;
  const agentName = params.agent;
  if (agentName) {
    agentDefs = loadAgentDefaults(agentName.toLowerCase());
  }
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) parts.push("--tools", shellEscape(toolAllowlist));

  const denySet = resolveDenyTools(agentDefs);

  // ── Resume message file ──────────────────────────────────────
  let resumeMsgFile: string | undefined;
  if (params.message) {
    const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    resumeMsgFile = join(artifactDir, "subagent-resume", `${name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`);
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, params.message, "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  // ── Environment variables ────────────────────────────────────
  const resumeEnvParts: string[] = [];
  if (process.env.PI_CODING_AGENT_DIR) resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
  resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
  resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  if (agentName) resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(agentName)}`);
  if (autoExit) resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  if (denySet.size > 0) resumeEnvParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

  const nonce = Math.random().toString(16).slice(2, 10);
  const command = `echo '__SUBAGENT_DONE_START_${nonce}__'; ${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_END_'$?'_${nonce}__'`;
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

// ─── renderSubagentResumeCall ────────────────────────────────────

export function renderSubagentResumeCall(args: any, theme: any) {
  const name = args.name ?? "Resume";
  return new Text("▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"), 0, 0);
}

// ─── renderSubagentResumeResult ──────────────────────────────────

export function renderSubagentResumeResult(result: any, _opts: any, theme: any) {
  const details = result.details as any;
  const name = details?.name ?? "Resume";
  if (details?.status === "started") {
    return new Text(theme.fg("accent", "▸") + " " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resumed"), 0, 0);
  }
  const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
  return new Text(theme.fg("dim", text), 0, 0);
}

// ─── createSubagentResumeTool ────────────────────────────────────

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
      agent: Type.Optional(Type.String({ description: "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads agent definition for tool enforcement." })),
    }),
    execute: (id: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) =>
      executeSubagentResume(id, params, signal, onUpdate, ctx, pi),
    renderCall: renderSubagentResumeCall,
    renderResult: renderSubagentResumeResult,
  };
}
