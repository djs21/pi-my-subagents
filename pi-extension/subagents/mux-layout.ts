/**
 * DWM-style tile layout for subagent panes.
 *
 * First subagent splits the main pane to the right.
 * Subsequent subagents split the previous subagent pane downward.
 * Result: main agent on left, subagents stacked vertically on right.
 *
 * ```
 *            | sub-a
 *            |------
 * main agent | sub-b
 *            |------
 *            | sub-c
 * ```
 */

import type { MuxBackend } from "./mux.ts";

/** Track the most recently created subagent pane for DWM tiling. */
let lastSubagentSurface: string | null = null;

/**
 * Reset the layout tracking. Call when starting fresh (e.g., new session).
 */
export function resetTilingLayout(): void {
  lastSubagentSurface = null;
}

/**
 * Create a tiled surface for a subagent.
 *
 * DWM tile: first split right, subsequent split down from previous pane.
 * If the tracked pane was closed (pane_not_found), resets and retries
 * with a right split from the main pane.
 *
 * @param name Display name for the pane
 * @param backend Current mux backend
 * @param splitFn Function to create a split
 * @returns Surface identifier for the new pane
 */
export function createTileSurface(
  name: string,
  backend: MuxBackend | null,
  splitFn: (name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string) => string,
): string {
  if (!backend) throw new Error("No mux backend available");

  if (!lastSubagentSurface) {
    // First subagent: right split from current pane
    lastSubagentSurface = splitFn(name, "right", undefined);
    return lastSubagentSurface;
  }

  // Subsequent subagents: down split from the previous subagent pane
  // If the previous pane was already closed (e.g. subagent completed),
  // fall back to a right split from the main pane.
  try {
    lastSubagentSurface = splitFn(name, "down", lastSubagentSurface);
    return lastSubagentSurface;
  } catch {
    // Pane was closed — reset layout and retry with right split
    lastSubagentSurface = null;
    lastSubagentSurface = splitFn(name, "right", undefined);
    return lastSubagentSurface;
  }
}
