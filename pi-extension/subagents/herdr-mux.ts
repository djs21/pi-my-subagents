import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function dbg(...args: any[]) {
  try {
    writeFileSync("/tmp/herdr-dbg.log", args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ") + "\n", { flag: "a" });
  } catch {}
}

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
    dbg(`herdrGetPaneHeight(${pane}) => ${h}`);
    return h;
  } catch (e) {
    dbg(`herdrGetPaneHeight(${pane}) ERROR: ${e}`);
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

  dbg(`=== herdrResizeStack START ===`);
  dbg(`panes: ${JSON.stringify(panes)}, targetHeight: ${targetHeight}`);

  try {
    for (let i = 0; i < panes.length - 1; i++) {
      dbg(`--- Iteration ${i} ---`);

      // Re-fetch layout before each resize for accurate measurements
      const raw = execFileSync("herdr", ["pane", "layout", "--pane", panes[i]], {
        encoding: "utf8",
      });
      const data = JSON.parse(raw);
      const layoutPanes: Array<{ pane_id: string; rect: { height: number } }> =
        data?.result?.layout?.panes ?? [];

      dbg(`layout panes found: ${layoutPanes.length}`);
      dbg(`all pane ids: ${JSON.stringify(layoutPanes.map(p => ({ id: p.pane_id, h: p.rect.height })))}`);

      // Sum heights of THIS pane and all panes below it
      let remainingTotal = 0;
      let topHeight = 0;
      for (let j = i; j < panes.length; j++) {
        const h = layoutPanes.find((p) => p.pane_id === panes[j])?.rect?.height ?? 0;
        if (j === i) topHeight = h;
        remainingTotal += h;
        dbg(`  find ${panes[j]}: height=${h}`);
      }

      dbg(`topHeight=${topHeight}, remainingTotal=${remainingTotal}`);

      if (remainingTotal <= 0 || topHeight <= 0) {
        dbg(`SKIP: remainingTotal=${remainingTotal}, topHeight=${topHeight}`);
        continue;
      }

      const currentRatio = topHeight / remainingTotal;
      const targetRatio = targetHeight / remainingTotal;

      dbg(`currentRatio=${currentRatio.toFixed(4)}, targetRatio=${targetRatio.toFixed(4)}`);

      if (Math.abs(targetRatio - currentRatio) < 0.01) {
        dbg(`SKIP: delta < 0.01`);
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

      dbg(`RESIZE: pane=${targetPane}, direction=${direction}, amount=${Math.min(delta, 0.8).toFixed(4)} (topPanes[i]=${panes[i]})`);

      execFileSync("herdr", [
        "pane",
        "resize",
        "--direction", direction,
        "--amount", String(Math.min(delta, 0.8)),
        "--pane", targetPane,
      ], { encoding: "utf8" });

      dbg(`Resize ${i} done`);
    }
    dbg(`=== herdrResizeStack END ===`);
  } catch (e) {
    dbg(`herdrResizeStack ERROR: ${e}`);
    // Best-effort — silently ignore failures
  }
}
