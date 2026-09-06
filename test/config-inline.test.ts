import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSubagentConfig, getConfigPath } from "../pi-extension/subagents/config.js";

/**
 * Tests for config.ts inlining.
 *
 * loadJsonConfig was a private helper called only once by readSubagentConfig.
 * Inlining it into readSubagentConfig removes an unnecessary function hop.
 */

describe("config.ts inlining", () => {
  it("readSubagentConfig returns null when config file does not exist", () => {
    const result = readSubagentConfig("project", "/nonexistent/path/for/sure");
    assert.strictEqual(result, null);
  });

  it("readSubagentConfig reads valid JSON config", async () => {
    const { writeFileSync, mkdirSync, rmSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const dir = mkdtempSync(join(tmpdir(), "config-inline-test-"));
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    const configFile = join(piDir, "subagent-config.json");
    writeFileSync(configFile, JSON.stringify({ layout: "monocle" }));

    try {
      const config = readSubagentConfig("project", dir);
      assert.strictEqual(config?.layout, "monocle");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getConfigPath is preserved as public API for slash commands", () => {
    const path = getConfigPath("project", "/test/dir");
    assert.strictEqual(path, "/test/dir/.pi/subagent-config.json");
  });
});
