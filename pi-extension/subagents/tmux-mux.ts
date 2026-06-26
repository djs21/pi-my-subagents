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
