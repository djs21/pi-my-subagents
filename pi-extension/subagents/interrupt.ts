/**
 * Subagent monitoring and interrupt handling.
 * Pure functions; module-level state (runningSubagents) is passed explicitly.
 */

import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import type { SubagentStatusKind } from "./status.ts";
import {
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import { activityLabel } from "./agent.ts";
import {
  sendEscape,
  getMuxBackend,
  closeSurface,
} from "./mux.ts";

// ─── Monitoring ─────────────────────────────────────────────────

export function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  (running as any).activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    (running as any).activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

// ─── Interrupt targeting ────────────────────────────────────────

export function resolveInterruptTarget(
  params: { id?: string; name?: string },
  runningSubagents: Map<string, RunningSubagent>,
): { running: RunningSubagent } | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

// ─── Interrupt execution ────────────────────────────────────────

export function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

export function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  runningSubagents: Map<string, RunningSubagent>,
  onUpdateWidget: () => void,
  sendEscapeKey: (surface: string) => void = sendEscape,
  closeSurfaceFn: (surface: string) => void = closeSurface,
) {
  const resolved = resolveInterruptTarget(params, runningSubagents);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  onUpdateWidget();

  // Fully terminate the subagent: abort watcher, close pane, cleanup
  running.abortController?.abort();
  closeSurfaceFn(running.surface);
  runningSubagents.delete(running.id);

  return {
    content: [{ type: "text" as const, text: `Sub-agent "${running.name}" aborted (interrupted and terminated).` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

// ─── Continuous stall tracking ────────────────────────────────────

/**
 * Pure function: given current stall tracking state and classified status entries,
 * return new tracking state and list of ids to clean up.
 * Interactive entries never appear in toCleanup.
 */
export function updateStallTracking(
  trackedStalls: Map<string, number>,
  now: number,
  thresholdMs: number,
  entries: { id: string; kind: SubagentStatusKind; interactive: boolean }[],
): { stallStarts: Map<string, number>; toCleanup: string[] } {
  const stallStarts = new Map(trackedStalls);
  const toCleanup: string[] = [];

  for (const entry of entries) {
    if (entry.kind !== "stalled") {
      // Recovered or never stalled — reset tracking
      stallStarts.delete(entry.id);
      continue;
    }

    // Entry is stalled
    if (!stallStarts.has(entry.id)) {
      // First tick seeing this stall — record start time
      stallStarts.set(entry.id, now);
    } else if (!entry.interactive) {
      // Already tracked — check if threshold exceeded
      const startMs = stallStarts.get(entry.id)!;
      if (now - startMs > thresholdMs) {
        toCleanup.push(entry.id);
        stallStarts.delete(entry.id);
      }
    }
  }

  return { stallStarts, toCleanup };
}

function getAutoCleanupThresholdMs(): number {
  const raw = process.env.PI_SUBAGENT_AUTO_CLEANUP_MS?.trim();
  if (raw === undefined || raw === "") return 300_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

// ─── Status refresh loop ────────────────────────────────────────

let statusInterval: ReturnType<typeof setInterval> | null = null;

const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");

// Clear previous interval on module reload
{
  const prev = (globalThis as any)[STATUS_INTERVAL_KEY] as ReturnType<typeof setInterval> | undefined;
  if (prev) {
    clearInterval(prev);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

export function startStatusRefresh(
  pi: { sendMessage(msg: any, opts?: any): void },
  statusConfig: { enabled: boolean; lineLimit: number },
  runningSubagents: Map<string, RunningSubagent>,
  onUpdateWidget: () => void,
) {
  if (!statusConfig.enabled || statusInterval) return;

  // Track continuous stall start time per subagent id (local to this closure)
  const stallTrackedStarts = new Map<string, number>();
  const autoCleanupThresholdMs = getAutoCleanupThresholdMs();

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    const stalledAgents: Array<{ id: string; name: string; task: string; agent?: string; sessionFile: string; elapsed: number }> = [];

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));

        // Dedicated stall message — one per subagent that transitions to stalled
        if (transition === "stalled") {
          stalledAgents.push({
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            sessionFile: running.sessionFile,
            elapsed: Math.floor((now - running.startTime) / 1000),
          });
        }
      }
    }

    // ── Continuous stall tracking & auto-cleanup ──
    if (autoCleanupThresholdMs > 0) {
      const entries = Array.from(runningSubagents.values()).map((r) => ({
        id: r.id,
        kind: r.statusState.currentKind,
        interactive: r.interactive,
      }));
      const { stallStarts, toCleanup } = updateStallTracking(
        stallTrackedStarts,
        now,
        autoCleanupThresholdMs,
        entries,
      );
      // Capture durations BEFORE syncing (updateStallTracking removes cleaned entries)
      const cleanupDurations = new Map<string, number>();
      for (const id of toCleanup) {
        const startMs = stallTrackedStarts.get(id);
        if (startMs !== undefined) {
          cleanupDurations.set(id, now - startMs);
        }
      }

      // Sync the tracking map
      stallTrackedStarts.clear();
      for (const [id, startMs] of stallStarts) {
        stallTrackedStarts.set(id, startMs);
      }

      for (const id of toCleanup) {
        // Race guard: skip if already removed by manual interrupt
        const running = runningSubagents.get(id);
        if (!running) continue;

        const stallDurationMs = cleanupDurations.get(id) ?? 0;
        try {
          running.abortController?.abort();
          closeSurface(running.surface);
        } finally {
          runningSubagents.delete(id);
          stallTrackedStarts.delete(id);
        }

        pi.sendMessage(
          {
            customType: "subagent_stalled",
            content: `Subagent "${running.name}" auto-cleaned after ${Math.floor(stallDurationMs / 1000)}s stalled. Task: ${running.task}`,
            display: true,
            details: {
              id: running.id,
              name: running.name,
              task: running.task,
              agent: running.agent,
              sessionFile: running.sessionFile,
              elapsed: Math.floor((now - running.startTime) / 1000),
              cleaned: true,
              stallDurationMs,
            },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }

    if (shouldRefreshWidget) onUpdateWidget();

    // Aggregate status transition lines (existing behavior)
    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }

    // Dedicated stall notification per subagent (for orchestrator/main agent)
    for (const agent of stalledAgents) {
      const elapsedLabel = agent.elapsed >= 60
        ? `${Math.floor(agent.elapsed / 60)}m ${agent.elapsed % 60}s`
        : `${agent.elapsed}s`;
      pi.sendMessage(
        {
          customType: "subagent_stalled",
          content: `Subagent "${agent.name}" stalled (idle) after ${elapsedLabel}. Task: ${agent.task}`,
          display: true,
          details: agent,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export function cleanupStatusTimer() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}
