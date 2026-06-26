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
import type { LayoutType } from "./types.ts";

/** Shared split ratio: new pane gets 30%, main pane gets 70%. */
export const DEFAULT_SPLIT_RATIO = 0.30;

/** Track the most recently created subagent pane for DWM tiling. */
let lastSubagentSurface: string | null = null;

/** Stack of subagent pane IDs in the right column for equalize. */
let stackPanes: string[] = [];

/**
 * Equalize heights of all panes in the stack so each gets 1/N of total height.
 * No-op when fewer than 2 panes.
 */
export function equalizePanes(
  panes: string[],
  resizeFn: (panes: string[], targetSize: number) => void,
  getSizeFn: (pane: string) => number,
): void {
  if (panes.length < 2) return;
  const totalHeight = panes.reduce((sum, p) => sum + getSizeFn(p), 0);
  const target = Math.floor(totalHeight / panes.length);
  resizeFn(panes, target);
}

/** @deprecated Use equalizePanes instead */
export const equalizeStack = equalizePanes;

/**
 * Reset the layout tracking. Call when starting fresh (e.g., new session).
 */
export function resetLayout(): void {
  lastSubagentSurface = null;
  stackPanes = [];
}

/** @deprecated Use resetLayout instead */
export const resetTilingLayout = resetLayout;

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
  splitFn: (name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, ratio?: number) => string,
  resizeFn?: (panes: string[], targetSize: number) => void,
  getSizeFn?: (pane: string) => number,
  layoutMode: LayoutType = "tiling",
): string {
  if (!backend) throw new Error("No mux backend available");

  const firstDirection = layoutMode === "bottom-stack" ? "down" : "right";
  const nextDirection = layoutMode === "bottom-stack" ? "right" : "down";
  const useFirstRatio = layoutMode === "bottom-stack";

  if (!lastSubagentSurface) {
    lastSubagentSurface = useFirstRatio
      ? splitFn(name, firstDirection, undefined, DEFAULT_SPLIT_RATIO)
      : splitFn(name, firstDirection, undefined);
    stackPanes.push(lastSubagentSurface);
    return lastSubagentSurface;
  }

  try {
    lastSubagentSurface = splitFn(name, nextDirection, lastSubagentSurface);
    stackPanes.push(lastSubagentSurface);
    if (resizeFn && getSizeFn) {
      equalizePanes(stackPanes, resizeFn, getSizeFn);
    }
    return lastSubagentSurface;
  } catch {
    lastSubagentSurface = null;
    stackPanes = [];
    lastSubagentSurface = useFirstRatio
      ? splitFn(name, firstDirection, undefined, DEFAULT_SPLIT_RATIO)
      : splitFn(name, firstDirection, undefined);
    stackPanes.push(lastSubagentSurface);
    return lastSubagentSurface;
  }
}
