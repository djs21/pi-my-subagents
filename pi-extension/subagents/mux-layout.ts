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
 * @param name Display name for the pane
 * @param backend Current mux backend
 * @param splitFn Function to create a split (takes name, direction, fromSurface)
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
  lastSubagentSurface = splitFn(name, "down", lastSubagentSurface);
  return lastSubagentSurface;
}
