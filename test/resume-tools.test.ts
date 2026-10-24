import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  seedSubagentSessionFile,
  getSessionAgent,
} from "../pi-extension/subagents/session.ts";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  it("Slice 2: Auto-detects agent from session and inherits full tool surface for PNR", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const { resolveDenyTools } = await import("../pi-extension/subagents/enforce.ts");
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
    // Bundled PNR does not declare restrictive tools frontmatter → inherits all tools (null allowlist)
    assert.equal(result.toolAllowlist, null, "toolAllowlist must be null for bundled PNR to inherit all tools");
    // Orchestrator tools are always denied, regardless of agent
    const denied = resolveDenyTools(result.agentDefs);
    for (const tool of ["subagent", "subagent_resume", "subagent_interrupt", "subagent_status", "subagents_list"]) {
      assert.equal(denied.has(tool), true, `must deny ${tool}`);
    }
  });
  it("Slice 2b: Honors explicit tools frontmatter when present on custom agent", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const prevCwd = process.cwd();
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(tmpdir(), "subagents-custom-tools-"));
    const agentsDir = join(root, ".pi", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "custom-tools-agent.md"),
      "---\nname: custom-tools-agent\ntools: read, bash, write\nmodel: anthropic/test\n---\n\nAgent with explicit tools.\n",
    );
    process.chdir(root);
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    try {
      const sessionFile = join(dir, "custom-tools-session.jsonl");
      seedSubagentSessionFile({
        mode: "standalone",
        childSessionFile: sessionFile,
        childCwd: process.cwd(),
        agent: "custom-tools-agent",
      });
      const result = resolveResumeTools({ sessionPath: sessionFile });
      assert.equal(result.resolvedAgent, "custom-tools-agent");
      assert.ok(result.toolAllowlist);
      const tools = result.toolAllowlist!.split(",");
      assert.ok(tools.includes("read"));
      assert.ok(tools.includes("bash"));
      assert.ok(tools.includes("write"));
      assert.ok(tools.includes("subagent_done"));
    } finally {
      process.chdir(prevCwd);
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
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
    assert.equal(result.toolAllowlist, null, "worker fallback inherits all tools (no allowlist)");
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
  it("Slice 5: Worker resumed without agent param inherits all tools", async () => {
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
    // Worker no longer declares explicit tools in frontmatter → inherits all tools
    assert.equal(result.toolAllowlist, null, "worker inherits all tools (no allowlist)");
  });
  it("Slice 5: Reviewer resumed without agent param inherits all tools & preserves identity", async () => {
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
    // Reviewer no longer declares explicit tools in frontmatter → inherits all tools
    assert.equal(result.toolAllowlist, null, "reviewer inherits all tools (no allowlist)");
  });

  it("New model: agent without explicit tools inherits the full environment tool surface", async () => {
    const { resolveResumeTools } = await import("../pi-extension/subagents/resume.ts");
    const { loadAgentDefaults: load } = await import("../pi-extension/subagents/agent.ts");
    const { writeFileSync: write, mkdirSync: mkdir } = await import("node:fs");
    const prevCwd = process.cwd();
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(tmpdir(), "subagents-inherit-tools-"));
    const agentsDir = join(root, ".pi", "agents");
    mkdir(agentsDir, { recursive: true });
    write(
      join(agentsDir, "inherit-tools-agent.md"),
      "---\nname: inherit-tools-agent\nmodel: anthropic/test\n---\n\nBare agent.\n",
    );
    process.chdir(root);
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    try {
      const defs = load("inherit-tools-agent");
      assert.ok(defs, "agent must load");
      assert.equal(defs.tools, undefined, "test agent must not declare explicit tools");

      const sessionFile = join(dir, "inherit-tools-session.jsonl");
      seedSubagentSessionFile({
        mode: "standalone",
        childSessionFile: sessionFile,
        childCwd: process.cwd(),
        agent: "inherit-tools-agent",
      });
      const result = resolveResumeTools({ sessionPath: sessionFile });
      assert.equal(result.toolAllowlist, null, "no explicit tools → inherit all (no allowlist)");
    } finally {
      process.chdir(prevCwd);
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("Slice 5: createSubagentResumeTool schema exposes optional tools parameter", async () => {
    const { createSubagentResumeTool } = await import("../pi-extension/subagents/resume.ts");
    const tool = createSubagentResumeTool({} as any);
    assert.ok(tool.parameters.properties.tools, "schema must include tools parameter");
    assert.ok(tool.parameters.properties.agent, "schema must include agent parameter");
    assert.ok(tool.parameters.properties.sessionPath, "schema must include sessionPath parameter");
  });
});


describe("shared.ts - cleanupSubagentResources", () => {
  it("cleans up launch script on exit", async () => {
    const { cleanupSubagentResources } = await import("../pi-extension/subagents/shared.ts");

    const scriptDir = mkdtempSync(join(tmpdir(), "subagents-script-"));
    const launchScriptFile = join(scriptDir, "launch.sh");
    writeFileSync(launchScriptFile, "#!/bin/sh\necho hi");

    assert.ok(existsSync(launchScriptFile), "launchScriptFile must exist before cleanup");

    cleanupSubagentResources({ id: "test-cleanup-123", launchScriptFile } as any);

    assert.ok(!existsSync(launchScriptFile), "launchScriptFile must be removed after cleanup");

    rmSync(scriptDir, { recursive: true, force: true });
  });
});

describe("session.ts - pruneStaleSessions", () => {
  it("prunes sessions older than maxAgeDays and respects maxFiles", async () => {
    const { pruneStaleSessions } = await import("../pi-extension/subagents/session.ts");
    const dir = mkdtempSync(join(tmpdir(), "session-prune-test-"));
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    // Create 1 recent file, 2 old files
    const recentFile = join(dir, "2026-09-06_recent.jsonl");
    const oldFile1 = join(dir, "2026-08-01_old1.jsonl");
    const oldFile2 = join(dir, "2026-08-02_old2.jsonl");

    writeFileSync(recentFile, "header\n");
    writeFileSync(oldFile1, "header\n");
    writeFileSync(oldFile2, "header\n");

    const { utimesSync } = await import("node:fs");
    // Set mtime to 10 days ago for old files
    const tenDaysAgo = new Date(now - 10 * dayMs);
    utimesSync(oldFile1, tenDaysAgo, tenDaysAgo);
    utimesSync(oldFile2, tenDaysAgo, tenDaysAgo);

    const pruned = pruneStaleSessions(dir, { maxAgeDays: 7 });
    assert.equal(pruned, 2, "must prune 2 old files");
    assert.ok(existsSync(recentFile), "recent file must be kept");
    assert.ok(!existsSync(oldFile1), "oldFile1 must be deleted");
    assert.ok(!existsSync(oldFile2), "oldFile2 must be deleted");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config.ts - loadJsonConfig error warning", () => {
  it("warns when JSON config file is malformed", async () => {
    const { readSubagentConfig } = await import("../pi-extension/subagents/config.ts");
    const dir = mkdtempSync(join(tmpdir(), "config-warn-test-"));
    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    const configFile = join(piDir, "subagent-config.json");
    writeFileSync(configFile, "{ invalid json: true, }");

    let warned = false;
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      if (args.some((a) => typeof a === "string" && a.includes("[subagents] Warning"))) {
        warned = true;
      }
      originalWarn.apply(console, args);
    };

    try {
      const config = readSubagentConfig("project", dir);
      assert.equal(config, null);
      assert.ok(warned, "must log warning for malformed JSON config");
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activity.ts - recorder cooldown recovery", () => {
  it("recovers after cooldown when write failures exceed threshold", async () => {
    const { createSubagentActivityRecorder } = await import("../pi-extension/subagents/activity.ts");
    let simulatedTime = 1000;
    const timeFn = () => simulatedTime;

    // Invalid file path to trigger write failures
    const recorder = createSubagentActivityRecorder("/nonexistent/readonly/activity.json", "child-1", timeFn);

    // Trigger 3 failures -> triggers cooldown
    recorder.turnStart(1);
    recorder.turnStart(2);
    recorder.turnStart(3);

    // Advance time past cooldown (35 seconds)
    simulatedTime += 35_000;

    // Next event should attempt flush again (not permanently disabled)
    assert.doesNotThrow(() => {
      recorder.turnStart(4);
    });
  });
});

describe("widget.ts - narrow width rendering", () => {
  it("handles extreme narrow widths without crashing or negative repeats", async () => {
    const { borderLine, borderTop, borderBottom, renderSubagentWidgetLines } = await import("../pi-extension/subagents/widget.ts");
    const dummyAgents: any[] = [{
      id: "abc",
      name: "worker",
      startTime: Date.now() - 5000,
      statusState: { source: "pi", startTimeMs: Date.now() - 5000 },
    }];

    for (const width of [0, 1, 2, 3, 4, 5]) {
      assert.doesNotThrow(() => borderLine("long title text", "long right label", width));
      assert.doesNotThrow(() => borderTop("Subagents", "1 running", width));
      assert.doesNotThrow(() => borderBottom(width));
      assert.doesNotThrow(() => renderSubagentWidgetLines(dummyAgents, width, true));
    }

    assert.deepStrictEqual(renderSubagentWidgetLines(dummyAgents, 0, true), []);
  });
});
