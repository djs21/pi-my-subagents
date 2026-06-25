/**
 * Subagent widget rendering and refresh lifecycle.
 *
 * Pure rendering functions plus module-level interval management.
 * `updateWidget()` and `startWidgetRefresh()` are the primary entry points;
 * they take explicit state (latestCtx, runningSubagents, statusEnabled) instead
 * of closing over module globals.
 */

import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import { formatElapsed } from "./agent.ts";
import type { StatusSnapshot, SubagentStatusState } from "./status.ts";
import { classifyStatus } from "./status.ts";
import type { SubagentActivityState } from "./activity.ts";

// ─── Module-level interval state ────────────────────────────────

const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");

let widgetInterval: ReturnType<typeof setInterval> | null = null;

// Clear previous interval on module reload (survive /reload)
{
  const prev = (globalThis as any)[WIDGET_INTERVAL_KEY] as ReturnType<typeof setInterval> | undefined;
  if (prev) {
    clearInterval(prev);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
}

// ─── ANSI helpers ───────────────────────────────────────────────

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

// ─── Display helpers ────────────────────────────────────────────

export function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

// ─── Border helpers ─────────────────────────────────────────────

export function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);

  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

export function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

export function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

// ─── Widget line renderer ───────────────────────────────────────

export function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  statusEnabled: boolean,
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const agentTag = "";
    const modelTag = agent.model ? ` [${agent.model}]` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag}${modelTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusEnabled
      ? formatWidgetRightLabel(snapshot)
      : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

// ─── Widget lifecycle ───────────────────────────────────────────

/**
 * Update the TUI widget with the current subagent state.
 * Explicitly pass state instead of closing over module globals.
 */
export function updateWidget(
  latestCtx: ExtensionContext | null,
  runningSubagents: Map<string, RunningSubagent>,
  statusEnabled: boolean,
) {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width, statusEnabled);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Start a 1-second interval that refreshes the widget.
 * No-op if already running.
 */
export function startWidgetRefresh(
  latestCtx: ExtensionContext | null,
  runningSubagents: Map<string, RunningSubagent>,
  statusEnabled: boolean,
) {
  if (widgetInterval) return;
  updateWidget(latestCtx, runningSubagents, statusEnabled); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget(latestCtx, runningSubagents, statusEnabled);
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/** Cleanup the widget interval timer (e.g. on session shutdown). */
export function cleanupWidgetTimer() {
  if (widgetInterval) {
    clearInterval(widgetInterval);
    widgetInterval = null;
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
}

// ─── Result presentation ────────────────────────────────────────

export function resolveResultPresentation(
  result: Pick<SubagentResult, "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage">,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";
  if (result.errorMessage) {
    return `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} (provider/agent error — auto-retry exhausted).\n\nError: ${result.errorMessage}${sessionRef}`;
  }
  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}
