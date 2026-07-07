import { describe, it } from "node:test";
import assert from "node:assert";
import { __pollForExitTest__ } from "../pi-extension/subagents/mux.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { interpretSentinelFile } = __pollForExitTest__;

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-test-"));
  const path = join(dir, "test.sentinel");
  writeFileSync(path, content);
  return path;
}

function cleanup(path: string) {
  rmSync(path, { force: true });
}

describe("mux.ts interpretSentinelFile", () => {
  it("parses exit code 0 correctly", () => {
    const path = tmpFile("0\n");
    try {
      const result = interpretSentinelFile(path);
      assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    } finally {
      cleanup(path);
      // Clean up parent dir too
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("parses non-zero exit code correctly", () => {
    const path = tmpFile("42\n");
    try {
      const result = interpretSentinelFile(path);
      assert.deepEqual(result, { reason: "sentinel", exitCode: 42 });
    } finally {
      cleanup(path);
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("falls back to 0 on empty file", () => {
    const path = tmpFile("\n");
    try {
      const result = interpretSentinelFile(path);
      assert.equal(result.reason, "sentinel");
      assert.equal(result.exitCode, 0);
    } finally {
      cleanup(path);
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });

  it("falls back to 0 on corrupt content (NaN)", () => {
    const path = tmpFile("not-a-number\n");
    try {
      const result = interpretSentinelFile(path);
      assert.equal(result.reason, "sentinel");
      assert.equal(result.exitCode, 0);
    } finally {
      cleanup(path);
      rmSync(join(path, ".."), { recursive: true, force: true });
    }
  });
});
