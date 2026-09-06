import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  seedSubagentSessionFile,
  getSessionAgent,
} from "../pi-extension/subagents/session.ts";

describe("session.ts - Agent metadata in session header (Tracer Bullet)", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-resume-test-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records agent in session header and getSessionAgent retrieves it", () => {
    const parentFile = join(dir, "parent.jsonl");
    const childFile = join(dir, "child.jsonl");

    seedSubagentSessionFile({
      mode: "lineage-only",
      parentSessionFile: parentFile,
      childSessionFile: childFile,
      childCwd: "/test/cwd",
      agent: "pnr",
    });

    // Verify header directly
    const lines = readFileSync(childFile, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]);
    assert.equal(header.agent, "pnr");

    // Verify through public reader function
    const detectedAgent = getSessionAgent(childFile);
    assert.equal(detectedAgent, "pnr");
  });

  it("returns null when session header has no agent field (legacy session)", () => {
    const childFile = join(dir, "legacy-child.jsonl");

    seedSubagentSessionFile({
      mode: "lineage-only",
      parentSessionFile: join(dir, "parent.jsonl"),
      childSessionFile: childFile,
      childCwd: "/test/cwd",
    });

    const detectedAgent = getSessionAgent(childFile);
    assert.equal(detectedAgent, null);
  });
});

describe("resume.ts - Auto-detection and Tool Resolution", () => {
  let dir: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "subagents-resume-tools-test-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it("Slice 2: Auto-detects agent from session and builds full allowlist for PNR", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "pnr-session.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
      agent: "pnr",
    });
    // Orchestrator calls resume WITHOUT specifying agent
    const result = resolveResumeTools({ sessionPath: sessionFile });
    assert.equal(result.resolvedAgent, "pnr");
    assert.ok(result.toolAllowlist, "toolAllowlist must not be null");
    // Must include all PNR tools
    const tools = result.toolAllowlist!.split(",");
    assert.ok(tools.includes("write"), "must include write");
    assert.ok(tools.includes("search"), "must include search");
    assert.ok(tools.includes("files"), "must include files");
    assert.ok(tools.includes("context"), "must include context");
    assert.ok(tools.includes("explore"), "must include explore");
    assert.ok(tools.includes("read"), "must include read");
    assert.ok(tools.includes("bash"), "must include bash");
    assert.ok(tools.includes("subagent_done"), "must include subagent_done");
  });
  it("Slice 3: Explicit agent parameter overrides session header agent", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "worker-session.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
      agent: "worker",
    });
    // Resume as reviewer explicitly
    const result = resolveResumeTools({ sessionPath: sessionFile, agent: "reviewer" });
    assert.equal(result.resolvedAgent, "reviewer");
  });
  it("Slice 3: Unknown agent falls back gracefully to worker defaults and warns", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "unknown-session.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
    });
    const result = resolveResumeTools({ sessionPath: sessionFile, agent: "nonexistent_custom_agent" });
    // Fallback to worker
    assert.equal(result.resolvedAgent, "worker");
    assert.ok(result.toolAllowlist);
    const tools = result.toolAllowlist!.split(",");
    assert.ok(tools.includes("read"));
    assert.ok(tools.includes("bash"));
  });
  it("Slice 4: Explicit tools override takes top precedence", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "pnr-session2.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
      agent: "pnr",
    });
    const result = resolveResumeTools({
      sessionPath: sessionFile,
      tools: "read,custom_tool",
    });
    const tools = result.toolAllowlist!.split(",");
    assert.ok(tools.includes("custom_tool"));
    assert.ok(tools.includes("read"));
  });
  it("Slice 5: Worker resumed without agent param preserves worker defaults (read, bash, write, edit if defined)", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "worker-auto.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
      agent: "worker",
    });
    const result = resolveResumeTools({ sessionPath: sessionFile });
    assert.equal(result.resolvedAgent, "worker");
    assert.ok(result.toolAllowlist);
  });
  it("Slice 5: Reviewer resumed without agent param preserves reviewer tools & identity", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const sessionFile = join(dir, "reviewer-auto.jsonl");
    seedSubagentSessionFile({
      mode: "standalone",
      childSessionFile: sessionFile,
      childCwd: process.cwd(),
      agent: "reviewer",
    });
    const result = resolveResumeTools({ sessionPath: sessionFile });
    assert.equal(result.resolvedAgent, "reviewer");
    assert.ok(result.toolAllowlist);
  });
  it("Slice 5: createSubagentResumeTool schema exposes optional tools parameter", async () => {
    const { createSubagentResumeTool } = await import("../pi-extension/subagents/resume.ts");
    const tool = createSubagentResumeTool({} as any);
    assert.ok(tool.parameters.properties.tools, "schema must include tools parameter");
    assert.ok(tool.parameters.properties.agent, "schema must include agent parameter");
    assert.ok(tool.parameters.properties.sessionPath, "schema must include sessionPath parameter");
  });
});
