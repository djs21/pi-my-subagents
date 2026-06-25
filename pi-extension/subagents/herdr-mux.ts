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
    return found?.rect?.height ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Equalize heights of all panes in the stack to targetHeight.
 * Herdr only supports ratio-delta resizing, so we calculate the
 * required ratio adjustment from layout dimensions.
 * Best-effort — failures are silently ignored.
 */
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

      if (remainingTotal <= 0 || topHeight <= 0) continue;

      const currentRatio = topHeight / remainingTotal;
      const targetRatio = targetHeight / remainingTotal;

      if (Math.abs(targetRatio - currentRatio) < 0.01) continue;

      const delta = Math.abs(targetRatio - currentRatio);
      const direction = targetRatio > currentRatio ? "down" : "up";

      execFileSync("herdr", [
        "pane",
        "resize",
        "--direction", direction,
        "--amount", String(Math.min(delta, 0.8)),
        "--pane", panes[i],
      ], { encoding: "utf8" });
    }
  } catch {
    // Best-effort — silently ignore failures
  }
}
