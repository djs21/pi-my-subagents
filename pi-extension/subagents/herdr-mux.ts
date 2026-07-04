import { execFileSync } from "node:child_process";

/**
 * Get the current height of a herdr pane in terminal rows.
 * Parses from `herdr pane layout` JSON output.
 * Returns 0 if pane can't be queried.
 */
export function herdrGetPaneHeight(pane: string): number {
  try {
    const raw = execFileSync("herdr", ["pane", "layout", "--pane", pane], {
      encoding: "utf8",
    });
    const data = JSON.parse(raw);
    const panes = data?.result?.layout?.panes ?? [];
    const found = panes.find((p: any) => p.pane_id === pane);
    const h = found?.rect?.height ?? 0;
    return h;
  } catch (e) {
    return 0;
  }
}

/**
 * Equalize heights of all panes in the stack to targetHeight.
 * Herdr only supports ratio-delta resizing, so we calculate the
 * required ratio adjustment from layout dimensions.
 * Best-effort — failures are silently ignored.
 */
/**
 * Get the current width of a herdr pane in columns.
 * Parses from `herdr pane layout` JSON output.
 */
export function herdrGetPaneWidth(pane: string): number {
  try {
    const raw = execFileSync("herdr", ["pane", "layout", "--pane", pane], { encoding: "utf8" });
    const data = JSON.parse(raw);
    const panes = data?.result?.layout?.panes ?? [];
    const found = panes.find((p: any) => p.pane_id === pane);
    return found?.rect?.width ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Equalize widths of all panes in the stack to targetWidth.
 * Mirrors herdrResizeStack but for horizontal resizing.
 */
export function herdrResizeWidths(panes: string[], targetWidth: number): void {
  if (panes.length < 2) return;

  try {
    for (let i = 0; i < panes.length - 1; i++) {
      const raw = execFileSync("herdr", ["pane", "layout", "--pane", panes[i]], { encoding: "utf8" });
      const data = JSON.parse(raw);
      const layoutPanes: Array<{ pane_id: string; rect: { width: number } }> =
        data?.result?.layout?.panes ?? [];

      let remainingTotal = 0;
      let leftWidth = 0;
      for (let j = i; j < panes.length; j++) {
        const w = layoutPanes.find((p) => p.pane_id === panes[j])?.rect?.width ?? 0;
        if (j === i) leftWidth = w;
        remainingTotal += w;
      }

      if (remainingTotal <= 0 || leftWidth <= 0) continue;

      const currentRatio = leftWidth / remainingTotal;
      const targetRatio = targetWidth / remainingTotal;

      if (Math.abs(targetRatio - currentRatio) < 0.01) continue;

      const delta = Math.abs(targetRatio - currentRatio);

      // For width resize:
      // "left" means decrease left pane (move border left), "right" means increase left pane
      const targetPane = currentRatio > targetRatio ? panes[i + 1] : panes[i];
      const direction = currentRatio > targetRatio ? "left" : "right";

      execFileSync("herdr", [
        "pane", "resize",
        "--direction", direction,
        "--amount", String(Math.min(delta, 0.8)),
        "--pane", targetPane,
      ], { encoding: "utf8" });
    }
  } catch {
    // Best-effort
  }
}

export function herdrResizeStack(panes: string[], targetHeight: number): void {
  if (panes.length < 2) return;

  try {
    for (let i = 0; i < panes.length - 1; i++) {
      // Re-fetch layout before each resize for accurate measurements
      const raw = execFileSync("herdr", ["pane", "layout", "--pane", panes[i]], {
        encoding: "utf8",
      });
      const data = JSON.parse(raw);
      const layoutPanes: Array<{ pane_id: string; rect: { height: number } }> =
        data?.result?.layout?.panes ?? [];

      // Sum heights of THIS pane and all panes below it
      let remainingTotal = 0;
      let topHeight = 0;
      for (let j = i; j < panes.length; j++) {
        const h = layoutPanes.find((p) => p.pane_id === panes[j])?.rect?.height ?? 0;
        if (j === i) topHeight = h;
        remainingTotal += h;
      }

      if (remainingTotal <= 0 || topHeight <= 0) {
        continue;
      }

      const currentRatio = topHeight / remainingTotal;
      const targetRatio = targetHeight / remainingTotal;

      if (Math.abs(targetRatio - currentRatio) < 0.01) {
        continue;
      }

      const delta = Math.abs(targetRatio - currentRatio);

      // Herdr: `--pane X --direction up` adjusts border ABOVE X,
      // `--pane X --direction down` adjusts border BELOW X.
      //
      // To adjust border between panes[i] and panes[i+1]:
      //   - SHRINK panes[i] (currentRatio > targetRatio):
      //     move border UP using pane BELOW border:
      //     `--pane panes[i+1] --direction up`
      //   - GROW panes[i] (currentRatio < targetRatio):
      //     move border DOWN using pane ABOVE border:
      //     `--pane panes[i] --direction down`
      const targetPane = currentRatio > targetRatio ? panes[i + 1] : panes[i];
      const direction = currentRatio > targetRatio ? "up" : "down";

      execFileSync("herdr", [
        "pane",
        "resize",
        "--direction", direction,
        "--amount", String(Math.min(delta, 0.8)),
        "--pane", targetPane,
      ], { encoding: "utf8" });
    }
  } catch (e) {
    // Best-effort — silently ignore failures
  }
}

/**
 * Create a new tab in a herdr workspace.
 * Returns the default (root) pane ID of the new tab.
 * The pane ID is used with `pane layout --pane` to query sibling panes.
 */
export function herdrCreateTab(workspaceId: string, tabName: string): string {
  try {
    const raw = execFileSync("herdr", [
      "tab", "create",
      "--workspace", workspaceId,
      "--label", tabName,
      "--no-focus",
    ], { encoding: "utf8" });
    const data = JSON.parse(raw);
    const rootPaneId = data?.result?.root_pane?.pane_id;
    if (!rootPaneId) throw new Error("Failed to parse herdr root pane id");
    return rootPaneId;
  } catch {
    throw new Error(`Failed to create herdr tab "${tabName}" in workspace ${workspaceId}`);
  }
}

/**
 * Get all pane IDs in the same tab as the given pane.
 * Herdr `pane layout --pane <paneId>` returns the layout for the
 * entire tab containing that pane, including all sibling panes.
 * Returns empty array if the tab can't be queried.
 */
export function herdrGetTabPanes(paneId: string): string[] {
  try {
    const raw = execFileSync("herdr", [
      "pane", "layout", "--pane", paneId,
    ], { encoding: "utf8" });
    const data = JSON.parse(raw);
    const panes: Array<{ pane_id: string }> = data?.result?.layout?.panes ?? [];
    return panes.map((p) => p.pane_id);
  } catch {
    return [];
  }
}
