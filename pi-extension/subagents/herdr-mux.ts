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
    const raw = execFileSync("herdr", ["pane", "layout", "--pane", panes[0]], {
      encoding: "utf8",
    });
    const data = JSON.parse(raw);
    const layoutPanes: Array<{
      pane_id: string;
      rect: { height: number; width: number; x: number; y: number };
    }> = data?.result?.layout?.panes ?? [];

    // Get rects for panes in our stack
    const paneRects = panes
      .map((id) => layoutPanes.find((p) => p.pane_id === id)?.rect)
      .filter(
        (r): r is { height: number; width: number; x: number; y: number } =>
          r !== undefined,
      );

    if (paneRects.length < 2) return;

    // For each adjacent pair, adjust the split ratio to reach targetHeight
    for (let i = 0; i < panes.length - 1; i++) {
      const topRect = paneRects[i];
      const bottomRect = paneRects[i + 1];
      const pairTotal = topRect.height + bottomRect.height;

      if (pairTotal <= 0) continue;

      const currentRatio = topRect.height / pairTotal;
      const targetRatio = targetHeight / pairTotal;

      if (Math.abs(targetRatio - currentRatio) < 0.01) continue;

      const delta = Math.abs(targetRatio - currentRatio);
      const direction = targetRatio > currentRatio ? "down" : "up";

      execFileSync(
        "herdr",
        [
          "pane",
          "resize",
          "--direction",
          direction,
          "--amount",
          String(Math.min(delta, 0.8)),
          "--pane",
          panes[i],
        ],
        { encoding: "utf8" },
      );
    }
  } catch {
    // Best-effort — silently ignore failures
  }
}
