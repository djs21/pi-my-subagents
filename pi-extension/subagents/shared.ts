/**
 * Shared lifecycle infrastructure — surface readiness, watchSubagent, runningSubagents,
 * widget wrappers, and module-level state.
 *
 * Imported by spin.ts and resume.ts. Does NOT import from enforce.ts, agent.ts, spin.ts, or resume.ts.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunningSubagent, SubagentResult } from "./types.ts";
import {
  pollForExit,
  closeSurface,
  sendCommand,
  readScreenAsync,
  getMuxBackend,
} from "./mux.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
} from "./session.ts";
import { loadStatusConfig } from "./status.ts";
import {
  updateWidget as widgetUpdateWidget,
  startWidgetRefresh as widgetStartWidgetRefresh,
} from "./widget.ts";

// ─── Module-level abort signal ────────────────────────────────────

const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

export function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

// ─── Coordination Constants ──────────────────────────────────────────

export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MESSAGES_PER_CALL = 10;
export const MAX_PENDING_FILES = 10;

// ─── Coordination Helpers ───────────────────────────────────────

/** Single source of truth for a subagent's coordination directory. */
export function getCoordDir(id: string): string {
  return join(process.env.HOME || "/tmp", ".local", "share", "pi", "subagents", id);
}

/**
 * Write an incoming message file to a subagent's coordination directory.
 * Creates `incoming/` recursively if needed. Returns the filename.
 */
export function writeIncomingMessage(coordDir: string, seq: number, text: string): string {
  const incoming = join(coordDir, "incoming");
  mkdirSync(incoming, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(16).slice(2, 6);
  const filename = `${ts}-${seq}-${rand}.txt`;
  writeFileSync(join(incoming, filename), text, "utf-8");
  return filename;
}

/** Count pending message files in incoming/. Treats missing dir as 0. */
export function countPendingFiles(coordDir: string): number {
  const incoming = join(coordDir, "incoming");
  if (!existsSync(incoming)) return 0;
  return readdirSync(incoming).filter(f => f.endsWith(".txt")).length;
}

// ─── Running Subagents ────────────────────────────────────────────

/** All currently running subagents, keyed by id. */
export const runningSubagents = new Map<string, RunningSubagent>();

// ─── Status Check Throttle ────────────────────────────────────────

let lastStatusCheckAt = 0;
let throttleStrikes = 0;
const MAX_THROTTLE_STRIKES = 3;

function effectiveInterval(): number {
  return statusConfig.minIntervalMs * 2 ** Math.min(throttleStrikes, MAX_THROTTLE_STRIKES);
}

export function resetStatusCheckThrottle(): void {
  lastStatusCheckAt = 0;
  throttleStrikes = 0;
}

export function getStatusCheckInterval(): number {
  return statusConfig.minIntervalMs;
}

export function checkStatusThrottle(): boolean {
  const now = Date.now();
  const interval = effectiveInterval();
  if (now - lastStatusCheckAt < interval) {
    lastStatusCheckAt = now;
    throttleStrikes++;
    return false;
  }
  lastStatusCheckAt = now;
  throttleStrikes = 0;
  return true;
}

export function getStatusThrottleRemainingMs(): number {
  if (lastStatusCheckAt === 0) return 0;
  const elapsed = Date.now() - lastStatusCheckAt;
  return Math.max(0, effectiveInterval() - elapsed);
}

export function getStatusThrottleStrikes(): number {
  return throttleStrikes;
}

// ─── Status Snapshot Cache ────────────────────────────────────────

let lastStatusSnapshot: { at: number; text: string } | null = null;

export function setStatusSnapshot(text: string): void {
  lastStatusSnapshot = { at: Date.now(), text };
}

export function getStatusSnapshot(): { at: number; text: string } | null {
  return lastStatusSnapshot;
}

// ─── Surface Readiness

/**
 * Wait for a mux surface's shell to be ready to accept commands.
 * Herdr surfaces are always ready (no polling needed).
 * Tmux surfaces are polled via a sentinel echo marker.
 *
 * @param surface  The mux pane/surface identifier.
 * @param options.skip  If true, skip readiness entirely (caller already ensured it).
 * @param options.label  Optional label for warning messages (e.g. "resume").
 */
export async function surfaceReadiness(
  surface: string,
  options?: { skip?: boolean; label?: string },
): Promise<void> {
  if (options?.skip) return;

  const backend = getMuxBackend();
  if (backend === "herdr") return;

  // Tmux: shell readiness polling via marker
  const timeoutMs = (() => {
    const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
  })();
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
      const label = options?.label ? ` ${options.label}` : "";
      console.warn(`[subagents] Shell readiness timeout${label} for pane ${surface} after ${timeoutMs}ms, proceeding anyway`);
    }
  } catch (err) {
    const label = options?.label ? ` ${options.label}` : "";
    console.warn(`[subagents] Shell readiness polling failed${label} for pane ${surface}: ${err}, proceeding anyway`);
  }
}

// ─── watchSubagent ────────────────────────────────────────────────

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

// ─── Widget Wrappers ──────────────────────────────────────────────

let latestCtx: any = null;

const statusConfig = loadStatusConfig();

export function setLatestCtx(ctx: any) {
  latestCtx = ctx;
}

export function updateWidget() {
  widgetUpdateWidget(latestCtx, runningSubagents, statusConfig.enabled);
}

export function startWidgetRefresh() {
  widgetStartWidgetRefresh(latestCtx, runningSubagents, statusConfig.enabled);
}
