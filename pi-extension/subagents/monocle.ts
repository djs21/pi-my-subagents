/**
 * Monocle layout for subagent panes.
 *
 * First subagent of a type → new window/tab named after the agent type (e.g. "scout").
 * Subsequent subagents of the same type → new pane inside that window (equalized heights).
 * Different agent type → different window/tab.
 */

import type { LayoutType } from "./types.ts";

/** A monocle group: all panes for one agent type inside one window. */
interface MonocleGroup {
  windowId: string;
  panes: string[];
}

/** Track windows by agent type name. */
let monocleState = new Map<string, MonocleGroup>();

/** Re-exported shared constant from mux-layout */
export const DEFAULT_SPLIT_RATIO = 0.30;

/**
 * Equalize heights of all panes in a group so each gets 1/N of total height.
 */
export function equalizeMonoclePanes(
  panes: string[],
  getSizeFn: (pane: string) => number,
  resizeFn: (panes: string[], targetSize: number) => void,
): void {
  if (panes.length < 2) return;
  const totalHeight = panes.reduce((sum, p) => sum + getSizeFn(p), 0);
  const target = Math.floor(totalHeight / panes.length);
  resizeFn(panes, target);
}

/**
 * Reset the monocle layout tracking. Call when starting fresh.
 */
export function resetMonocleLayout(): void {
  monocleState = new Map();
}

/**
 * Get the group name from a subagent name.
 * E.g. "scout-1" → "scout", "worker" → "worker"
 * Currently returns the name as-is (no special extraction).
 * Override this if agent type extraction logic changes later.
 */
export function getGroupName(name: string): string {
  return name;
}

/**
 * Create a monocle surface for a subagent.
 *
 * - First subagent of a type: calls createWindowFn(groupName) to create a new window/tab,
 *   then splits a pane inside it.
 * - Subsequent subagents of same type: adds a pane inside the existing window and equalizes.
 * - Different type: creates another new window.
 *
 * @param name Display name for the pane
 * @param splitFn Function to create a split inside a window
 * @param createWindowFn Function to create a new window/tab in the current session/workspace
 * @param getWindowPanesFn Function to list all pane IDs within a window
 * @param getSizeFn Function to get pane height
 * @param resizeFn Function to equalize pane heights
 * @returns Surface identifier for the new pane
 */
export function createMonocleSurface(
  name: string,
  splitFn: (name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, ratio?: number) => string,
  createWindowFn: (windowName: string) => string,
  getWindowPanesFn: (windowId: string) => string[],
  getSizeFn: (pane: string) => number,
  resizeFn: (panes: string[], targetSize: number) => void,
): string {
  const groupName = getGroupName(name);
  const existing = monocleState.get(groupName);

  if (!existing) {
    // First subagent of this type: create new window
    const windowId = createWindowFn(groupName);

    // Split pane inside the new window (right split, 30%)
    const paneId = splitFn(name, "right", undefined, DEFAULT_SPLIT_RATIO);

    monocleState.set(groupName, { windowId, panes: [paneId] });
    return paneId;
  }

  // Existing window: add pane inside it
  try {
    const lastPane = existing.panes[existing.panes.length - 1];
    const paneId = splitFn(name, "down", lastPane);

    existing.panes.push(paneId);

    // Refresh pane list from actual window state
    try {
      const actualPanes = getWindowPanesFn(existing.windowId);
      equalizeMonoclePanes(actualPanes, getSizeFn, resizeFn);
      existing.panes = actualPanes;
    } catch {
      // Best-effort equalize
    }

    return paneId;
  } catch {
    // Pane closure fallback: reset this group and retry as first agent
    monocleState.delete(groupName);
    return createMonocleSurface(name, splitFn, createWindowFn, getWindowPanesFn, getSizeFn, resizeFn);
  }
}
