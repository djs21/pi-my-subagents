import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for parseSessionMode inlining.
 *
 * parseSessionMode is a trivial function that maps strings to SubagentSessionMode.
 * After inlining, its logic lives directly in parseAgentDefinition and the
 * standalone function no longer exists.
 */

import { parseAgentDefinition } from "../pi-extension/subagents/agent.js";

function makeAgent(content: string): Record<string, unknown> | null {
  const result = parseAgentDefinition(content, "test-agent");
  if (!result) return null;
  return result as unknown as Record<string, unknown>;
}

describe("parseSessionMode inlining", () => {
  it("should accept 'standalone' as session mode", () => {
    const def = makeAgent("---\nname: test\nsession-mode: standalone\n---\nbody");
    assert.strictEqual(def?.sessionMode, "standalone");
  });

  it("should accept 'lineage-only' as session mode", () => {
    const def = makeAgent("---\nname: test\nsession-mode: lineage-only\n---\nbody");
    assert.strictEqual(def?.sessionMode, "lineage-only");
  });

  it("should accept 'fork' as session mode", () => {
    const def = makeAgent("---\nname: test\nsession-mode: fork\n---\nbody");
    assert.strictEqual(def?.sessionMode, "fork");
  });

  it("should return undefined for unknown session mode", () => {
    const def = makeAgent("---\nname: test\nsession-mode: bogus\n---\nbody");
    assert.strictEqual(def?.sessionMode, undefined);
  });

  it("should return undefined when session-mode is absent", () => {
    const def = makeAgent("---\nname: test\n---\nbody");
    assert.strictEqual(def?.sessionMode, undefined);
  });

  it("should not export parseSessionMode as standalone function", async () => {
    const mod = await import("../pi-extension/subagents/agent.js");
    assert.strictEqual(
      (mod as Record<string, unknown>).parseSessionMode,
      undefined,
      "parseSessionMode should no longer be exported — its logic is inlined in parseAgentDefinition"
    );
  });
});
