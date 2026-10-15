/**
 * Monocle layout for subagent panes.
 *
 * Pure monocle: every spawned subagent gets its own dedicated fullscreen
 * window/tab — no grouping by agent name, no sub-splitting, no stacking.
 * This maximizes the visible area for each subagent, which matters on small
 * screens (e.g. 11" 768p).
 */

/** Re-exported shared constant from mux-layout */
export const DEFAULT_SPLIT_RATIO = 0.30;

/**
 * Track the dedicated window/pane per subagent surface.
 * Keyed by the surface ID returned when the window was created, value is the
 * window ID that hosts it. Kept minimal: one entry per live subagent.
 */
let monocleWindows = new Map<string, string>();

/**
 * Reset the monocle layout tracking. Call when starting fresh.
 */
export function resetMonocleLayout(): void {
  monocleWindows = new Map();
}

/**
 * Look up the dedicated window that hosts a subagent surface.
 * Returns undefined when the surface was not created via monocle.
 */
export function getMonocleWindow(surface: string): string | undefined {
  return monocleWindows.get(surface);
}

/**
 * Create a monocle surface for a subagent.
 *
 * Each call creates a brand new window/tab dedicated to this subagent and
 * returns its default (fullscreen) pane. No name grouping, no splits.
 *
 * @param name Display name for the pane/window
 * @param createWindowFn Function to create a new window/tab in the current session/workspace
 * @param getWindowPanesFn Function to list all pane IDs within a window
 * @returns Surface identifier for the new pane
 */
export function createMonocleSurface(
  name: string,
  createWindowFn: (windowName: string) => string,
  getWindowPanesFn: (windowId: string) => string[],
): string {
  const windowId = createWindowFn(name);

  // Use the default pane created automatically by tmux/herdr — no split,
  // the subagent occupies the whole window/tab.
  const windowPanes = getWindowPanesFn(windowId);
  const paneId = windowPanes.length > 0 ? windowPanes[0] : undefined;
  if (!paneId) throw new Error(`No default pane in new window ${windowId}`);

  monocleWindows.set(paneId, windowId);
  return paneId;
}
