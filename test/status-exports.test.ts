import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests that internal-only constants are NOT exported from the status module.
 *
 * These constants are implementation details used only inside status.ts.
 * They should not be part of the module's public API.
 */

const INTERNAL_CONSTANTS = [
  "SNAPSHOT_STALLED_AFTER_MS",
  "ACTIVITY_STALLED_AFTER_MS",
  "DEFAULT_STATUS_LINE_LIMIT",
  "MAX_STATUS_NAME_LENGTH",
  "MAX_STATUS_LINE_LENGTH",
  "DEFAULT_STATUS_MIN_INTERVAL_MS",
  "MIN_STATUS_MIN_INTERVAL_MS",
] as const;

describe("status module exports", () => {
  it("should not export internal-only constants", async () => {
    const mod = await import("../pi-extension/subagents/status.js");

    for (const name of INTERNAL_CONSTANTS) {
      assert.strictEqual(
        (mod as Record<string, unknown>)[name],
        undefined,
        `${name} should NOT be exported from status module — it is an internal implementation detail`
      );
    }
  });

  it("should still export public runtime functions", async () => {
    const mod = await import("../pi-extension/subagents/status.js");

    // Runtime exports only (types don't exist at runtime)
    const expectedRuntimeExports = [
      "normalizeStatusName",
      "parseStatusConfig",
      "loadStatusConfig",
      "formatElapsedDuration",
      "createStatusState",
      "observeStatus",
      "forceStatusAfterInterrupt",
      "classifyStatus",
      "advanceStatusState",
      "formatStatusLine",
      "formatTransitionLine",
      "capStatusLines",
      "formatStatusAggregate",
    ];

    for (const name of expectedRuntimeExports) {
      assert.notStrictEqual(
        (mod as Record<string, unknown>)[name],
        undefined,
        `${name} should still be exported from status module`
      );
    }
  });
});
