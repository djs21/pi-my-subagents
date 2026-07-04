import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "herdr" | "tmux";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "herdr" || pref === "tmux") return pref;
  return null;
}

function isHerdrRuntimeAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function isTmuxRuntimeAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function getMuxBackend(): MuxBackend | null {
  if (isHerdrRuntimeAvailable()) return "herdr";
  if (isTmuxRuntimeAvailable()) return "tmux";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or herdr.";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
}

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

import {
  createTileSurface,
  resetLayout,
  DEFAULT_SPLIT_RATIO,
} from "./mux-layout.ts";
import {
  createMonocleSurface,
} from "./monocle.ts";
import { herdrResizeStack, herdrGetPaneHeight, herdrResizeWidths, herdrGetPaneWidth, herdrCreateTab, herdrGetTabPanes } from "./herdr-mux.ts";
import { tmuxResizeStack, tmuxGetPaneHeight, tmuxResizeWidths, tmuxGetPaneWidth, tmuxCreateWindow, tmuxGetWindowPanes, tmuxGetCurrentSession } from "./tmux-mux.ts";
import { loadSubagentConfig } from "./config.ts";
import type { LayoutType } from "./types.ts";

/**
 * Create a new terminal surface for a subagent.
 *
 * DWM tile layout: first subagent splits the main pane to the right,
 * subsequent subagents split the previous subagent pane downward.
 * Result: main agent on left, subagents stacked vertically on right.
 * Panels are also equalized to equal heights via the backend-specific
 * resize functions.
 *
 * Returns an identifier (herdr pane_id or tmux pane_id like `%12`).
 */
export function createSurface(name: string, layout?: LayoutType): string {
  const backend = getMuxBackend();

  // Read config for layout, with explicit override priority
  const effectiveLayout = layout ?? loadSubagentConfig(process.cwd())?.layout ?? "tiling";

  // Validate layout
  const validLayouts: LayoutType[] = ["tiling", "bottom-stack", "monocle"];
  const validatedLayout = validLayouts.includes(effectiveLayout) ? effectiveLayout : "tiling";

  if (validatedLayout === "monocle") {
    // Monocle: create window/tab per agent type
    const splitFn = (name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, ratio?: number) =>
      createSurfaceSplit(name, direction, fromSurface, ratio);

    const createWindowFn = (windowName: string): string => {
      if (backend === "herdr") {
        const wsId = process.env.HERDR_WORKSPACE_ID;
        if (!wsId) throw new Error("HERDR_WORKSPACE_ID not set");
        return herdrCreateTab(wsId, windowName);
      }
      if (backend === "tmux") {
        const sessionId = tmuxGetCurrentSession();
        if (!sessionId) throw new Error("Could not determine tmux session");
        return tmuxCreateWindow(sessionId, windowName);
      }
      throw new Error("Unsupported mux backend for monocle layout");
    };

    const getWindowPanesFn = (windowId: string): string[] => {
      if (backend === "herdr") return herdrGetTabPanes(windowId);
      if (backend === "tmux") return tmuxGetWindowPanes(windowId);
      return [];
    };

    const getSizeFn = backend === "herdr" ? herdrGetPaneHeight : tmuxGetPaneHeight;
    const resizeFn = backend === "herdr" ? herdrResizeStack : tmuxResizeStack;

    return createMonocleSurface(
      name, splitFn, createWindowFn, getWindowPanesFn, getSizeFn, resizeFn,
    );
  }

  if (validatedLayout === "bottom-stack") {
    const resizeFn = backend === "herdr" ? herdrResizeWidths : tmuxResizeWidths;
    const getSizeFn = backend === "herdr" ? herdrGetPaneWidth : tmuxGetPaneWidth;
    return createTileSurface(name, backend, createSurfaceSplit, resizeFn, getSizeFn, "bottom-stack");
  }

  // Default: tiling
  const resizeFn = backend === "herdr" ? herdrResizeStack : tmuxResizeStack;
  const getHeightFn = backend === "herdr" ? herdrGetPaneHeight : tmuxGetPaneHeight;
  return createTileSurface(name, backend, createSurfaceSplit, resizeFn, getHeightFn, "tiling");
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (herdr pane_id or tmux pane_id like `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  ratio?: number,
): string {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    const targetPane = fromSurface ?? process.env.HERDR_PANE_ID;
    if (!targetPane) throw new Error("No target pane for herdr split");
    const dir = direction === "left" || direction === "right" ? "right" : "down";
    const args = ["pane", "split", targetPane, "--direction", dir, "--no-focus"];
    if (ratio !== undefined) {
      // herdr --ratio is the existing pane's share, so pass (1-ratio) for new pane = ratio
      args.push("--ratio", String(1 - ratio));
    }
    const result = execFileSync("herdr", args, { encoding: "utf8" });
    const parsed = JSON.parse(result);
    const paneId = parsed?.result?.pane?.pane_id;
    if (!paneId) throw new Error("Failed to parse herdr pane id");
    return paneId;
  }

  if (backend === "tmux") {
    const args = ["split-window", "-d"];
    if (direction === "left" || direction === "right") {
      args.push("-h");
    } else {
      args.push("-v");
    }
    if (direction === "left" || direction === "up") {
      args.push("-b");
    }
    if (ratio !== undefined) {
      // tmux -p is percentage for NEW pane, so new pane gets ratio*100%
      args.push("-p", String(Math.round(ratio * 100)));
    }
    const target = fromSurface ?? process.env.TMUX_PANE;
    if (target) {
      args.push("-t", target);
    }
    args.push("-P", "-F", "#{pane_id}");

    const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }
    return pane;
  }

  throw new Error(`Unsupported mux backend: ${backend}`);
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
    return;
  }
}

/**
 * Send one Escape keypress to an active pane.
 */
export function sendEscape(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "send-keys", surface, "Escape"], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
    return;
  }
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  const backend = requireMuxBackend();
  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "run", surface, "bash " + shellEscape(scriptPath)], { encoding: "utf8" });
    return scriptPath;
  }

  // tmux
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    return execFileSync("herdr", ["pane", "read", surface, "--source", "recent", "--lines", String(lines)], { encoding: "utf8" });
  }

  if (backend === "tmux") {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
  }

  throw new Error(`Unsupported mux backend: ${backend}`);
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    const { stdout } = await execFileAsync("herdr", ["pane", "read", surface, "--source", "recent", "--lines", String(lines)], { encoding: "utf8" });
    return stdout;
  }

  if (backend === "tmux") {
    const { stdout } = await execFileAsync(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" },
    );
    return stdout;
  }

  throw new Error(`Unsupported mux backend: ${backend}`);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    return;
  }

  if (backend === "tmux") {
    execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
    return;
  }
}

/**
 * Rename a pane/surface to the given label.
 * Best-effort: failures are silently ignored.
 */
export function renameSurface(surface: string, label: string): void {
  const backend = getMuxBackend();

  if (backend === "herdr") {
    try {
      execFileSync("herdr", ["pane", "rename", surface, label], { encoding: "utf8" });
    } catch {
      // best-effort
    }
    return;
  }

  if (backend === "tmux") {
    try {
      execFileSync("tmux", ["select-pane", "-t", surface, "-T", label], { encoding: "utf8" });
    } catch {
      // best-effort
    }
    return;
  }
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    const tabId = process.env.HERDR_TAB_ID;
    if (tabId) {
      execFileSync("herdr", ["tab", "rename", tabId, title], { encoding: "utf8" });
    }
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") return;
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], { encoding: "utf8" }).trim();
    execFileSync("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
    return;
  }
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "herdr") {
    const wsId = process.env.HERDR_WORKSPACE_ID;
    if (wsId) {
      const wsNumber = wsId.replace(/^w/, "");
      execFileSync("herdr", ["workspace", "rename", wsNumber, title], { encoding: "utf8" });
    }
    return;
  }

  if (backend === "tmux") {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") return;
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync("tmux", ["display-message", "-p", "-t", paneId, "#{session_id}"], { encoding: "utf8" }).trim();
    execFileSync("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
    return;
  }
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by subagent_done / caller_ping /
 * the error path in subagent-done.ts). Centralized so both the fast and slow
 * paths in pollForExit decode the payload the same way.
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "ping") {
    return {
      reason: "ping",
      exitCode: 0,
      ping: { name: data.name, message: data.message },
    };
  }
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };
export const __test__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by subagent_done / caller_ping), falling back to the terminal
 * sentinel for crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      if (getMuxBackend() === "herdr") {
        // Herdr: use native blocking wait (event-driven, zero polling overhead)
        try {
          await execFileAsync("herdr", [
            "wait", "output", surface,
            "--match", "__SUBAGENT_DONE_END_",
            "--regex",
            "--source", "recent",
            "--lines", "200",
            "--timeout", String(options.interval),
          ], { timeout: options.interval + 2000 });
          // If we get here, match found
        } catch {
          // Timeout — sentinel not yet present, continue polling
          // (don't fall through to readScreenAsync, just wait for next loop)
        }
      }

      // For both backends: read screen and match
      const screen = await readScreenAsync(surface, 200);
      const match = screen.match(/__SUBAGENT_DONE_END_(\d+)_([a-f0-9]+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
