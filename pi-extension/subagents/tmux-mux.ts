import { execFileSync } from "node:child_process";

/**
 * Resize all panes in the stack to the same target height.
 * Uses tmux resize-pane -y for absolute height.
 * Silently skips panes that fail (e.g., already closed).
 */
export function tmuxResizeStack(panes: string[], targetHeight: number): void {
  for (const pane of panes) {
    try {
      execFileSync("tmux", ["resize-pane", "-y", String(targetHeight), "-t", pane], {
        encoding: "utf8",
      });
    } catch {
      // Pane may no longer exist — skip silently
    }
  }
}

/**
 * Get the current height of a tmux pane in lines.
 * Returns 0 if pane can't be queried.
 */
export function tmuxGetPaneHeight(pane: string): number {
  try {
    const result = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_height}"], {
      encoding: "utf8",
    });
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * Resize all panes in the stack to the same target width.
 * Uses tmux resize-pane -x for absolute width.
 * Silently skips panes that fail.
 */
export function tmuxResizeWidths(panes: string[], targetWidth: number): void {
  for (const pane of panes) {
    try {
      execFileSync("tmux", ["resize-pane", "-x", String(targetWidth), "-t", pane], {
        encoding: "utf8",
      });
    } catch {
      // Pane may no longer exist — skip silently
    }
  }
}

/**
 * Get the current width of a tmux pane in columns.
 * Returns 0 if pane can't be queried.
 */
export function tmuxGetPaneWidth(pane: string): number {
  try {
    const result = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{pane_width}"], {
      encoding: "utf8",
    });
    return parseInt(result.trim(), 10);
  } catch {
    return 0;
  }
}

/**
 * Create a new tmux window in a session.
 * Returns the new window ID.
 */
export function tmuxCreateWindow(sessionId: string, windowName: string): string {
  try {
    const result = execFileSync("tmux", [
      "new-window", "-t", sessionId,
      "-n", windowName,
      "-P", "-F", "#{window_id}",
    ], { encoding: "utf8" });
    return result.trim();
  } catch {
    throw new Error(`Failed to create tmux window "${windowName}" in session ${sessionId}`);
  }
}

/**
 * Get all pane IDs within a tmux window.
 * Returns empty array if window can't be queried.
 */
export function tmuxGetWindowPanes(windowId: string): string[] {
  try {
    const result = execFileSync("tmux", [
      "list-panes", "-t", windowId,
      "-F", "#{pane_id}",
    ], { encoding: "utf8" });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get the current tmux session ID.
 * First tries TMUX_PANE env var, then falls back to display-message.
 * Returns null if not in a tmux session.
 */
export function tmuxGetCurrentSession(): string | null {
  const tmuxPane = process.env.TMUX_PANE;
  if (!tmuxPane) return null;
  try {
    return execFileSync("tmux", [
      "display-message", "-p", "-t", tmuxPane,
      "#{session_id}",
    ], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
