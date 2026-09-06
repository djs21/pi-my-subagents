import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSubagentActivityFile } from "../pi-extension/subagents/activity.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for activity.ts validation inlining.
 *
 * Verifies that inlined validation checks in validateActivity produce
 * identical results to the original helper functions.
 */

function withTempActivity(data: unknown, fn: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "activity-test-"));
  const file = join(dir, "activity.json");
  writeFileSync(file, JSON.stringify(data));
  try {
    fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID_BASE = {
  version: 1,
  runningChildId: "child-1",
  latestEvent: "session_start",
  phase: "starting",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sequence: 1,
  agentActive: true,
  turnActive: false,
  providerActive: false,
  toolActive: false,
};

describe("activity.ts validation (inlined)", () => {
  it("accepts valid activity payload", () => {
    withTempActivity(VALID_BASE, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, true);
    });
  });

  it("rejects non-object payload", () => {
    withTempActivity("not-an-object", (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok) assert.strictEqual(result.reason, "invalid");
    });
  });

  it("rejects non-finite createdAt", () => {
    withTempActivity({ ...VALID_BASE, createdAt: "not-a-number" }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok && result.reason === "invalid") {
        assert.ok(result.error.includes("createdAt must be finite"));
      }
    });
  });

  it("rejects non-integer sequence", () => {
    withTempActivity({ ...VALID_BASE, sequence: 1.5 }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok && result.reason === "invalid") {
        assert.ok(result.error.includes("sequence must be an integer"));
      }
    });
  });

  it("rejects non-boolean agentActive", () => {
    withTempActivity({ ...VALID_BASE, agentActive: "true" }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok && result.reason === "invalid") {
        assert.ok(result.error.includes("agentActive must be a boolean"));
      }
    });
  });

  it("accepts optional fields when null/undefined", () => {
    withTempActivity({ ...VALID_BASE, activeSince: null, toolName: undefined }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, true);
    });
  });

  it("rejects invalid optional field when present", () => {
    withTempActivity({ ...VALID_BASE, activeSince: "not-a-number" }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok && result.reason === "invalid") {
        assert.ok(result.error.includes("activeSince must be finite when present"));
      }
    });
  });

  it("rejects string with newlines", () => {
    withTempActivity({ ...VALID_BASE, toolName: "read\nfile" }, (file) => {
      const result = readSubagentActivityFile(file, "child-1");
      assert.strictEqual(result.ok, false);
      if (!result.ok && result.reason === "invalid") {
        assert.ok(result.error.includes("toolName must not contain newlines"));
      }
    });
  });
});
