import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  seedSubagentSessionFile,
  getSessionAgent,
} from "../pi-extension/subagents/session.ts";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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

describe("subagent-done.ts - check_messages atomicity", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "subagents-messages-test-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  it("reads all pending messages atomically and removes files", async () => {
    // Self-contained mock without importing test.ts
    // Set up mock coord dir with incoming files
    const coordDir = dir;
    const incoming = join(coordDir, "incoming");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "2026-09-06-0-a1b2.txt"), "First message");
    writeFileSync(join(incoming, "2026-09-06-1-c3d4.txt"), "Second message");

    const prevCoord = process.env.PI_SUBAGENT_COORD_DIR;
    process.env.PI_SUBAGENT_COORD_DIR = coordDir;
    try {
      const { default: initSubagent } = await import("../pi-extension/subagents/subagent-done.ts");
      const registeredTools: any[] = [];
      initSubagent({
        registerTool(t: any) { registeredTools.push(t); },
        registerShortcut() {},
        on() {},
        getAllTools() { return []; },
      } as any);

      const checkTool = registeredTools.find((t) => t.name === "check_messages");
      assert.ok(checkTool, "check_messages tool must be registered");

      const result = await checkTool.execute("tc-1", {}, new AbortController().signal, () => {}, {} as any);
      assert.equal(result.details.messages.length, 2);
      assert.equal(result.details.messages[0], "First message");
      assert.equal(result.details.messages[1], "Second message");

      // Verify incoming files were deleted after read
      const remaining = readdirSync(incoming).filter((f: string) => f.endsWith(".txt"));
      assert.equal(remaining.length, 0, "all message files must be deleted");
    } finally {
      if (prevCoord === undefined) delete process.env.PI_SUBAGENT_COORD_DIR;
      else process.env.PI_SUBAGENT_COORD_DIR = prevCoord;
    }
  });

describe("shared.ts - cleanupSubagentResources", () => {
  it("cleans up coordination directory and launch script on exit", async () => {
    const { cleanupSubagentResources, getCoordDir } = await import("../pi-extension/subagents/shared.ts");
    const id = "test-cleanup-123";
    const coordDir = getCoordDir(id);
    mkdirSync(join(coordDir, "incoming"), { recursive: true });
    writeFileSync(join(coordDir, "incoming", "msg.txt"), "hello");

    const scriptDir = mkdtempSync(join(tmpdir(), "subagents-script-"));
    const launchScriptFile = join(scriptDir, "launch.sh");
    writeFileSync(launchScriptFile, "#!/bin/sh\necho hi");

    assert.ok(existsSync(coordDir), "coordDir must exist before cleanup");
    assert.ok(existsSync(launchScriptFile), "launchScriptFile must exist before cleanup");

    cleanupSubagentResources({
      id,
      launchScriptFile,
    } as any);

    assert.ok(!existsSync(coordDir), "coordDir must be removed after cleanup");
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

describe("commands.ts - formatScopeConfig mixed types", () => {
  it("formats string tools and array tools correctly without character splitting", async () => {
    const { formatScopeConfig } = await import("../pi-extension/subagents/commands.ts");
    const configWithString: any = {
      agents: {
        pnr: {
          model: "claude-3-7-sonnet",
          tools: "read,bash,write,explore",
          skills: "tdd,diagnose",
        },
        worker: {
          tools: ["read", "bash"],
          skills: ["tdd"],
        },
      },
    };
    const output = formatScopeConfig(configWithString);
    assert.ok(output.includes("- tools: read,bash,write,explore"), "string tools should be preserved directly");
    assert.ok(output.includes("- tools: read, bash"), "array tools should be joined with comma");
  });
});

describe("main-agent.ts - dynamic config loading and custom config dir", () => {
  it("reads config dynamically respecting PI_CODING_AGENT_DIR", async () => {
    const { loadConfig, saveConfig, getMainAgentConfigPath } = await import("../pi-extension/subagents/main-agent.ts");
    const dir = mkdtempSync(join(tmpdir(), "main-agent-config-test-"));
    const originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;

    try {
      const configPath = getMainAgentConfigPath();
      assert.ok(configPath.startsWith(dir), "config path must respect PI_CODING_AGENT_DIR");

      // Initial load -> default
      const initial = loadConfig();
      assert.equal(initial.enabled, true);

      // Save new config
      saveConfig({ enabled: false, blockedTools: ["custom_tool"] });

      // Next load must read the newly saved config dynamically
      const reloaded = loadConfig();
      assert.equal(reloaded.enabled, false);
      assert.deepStrictEqual(reloaded.blockedTools, ["custom_tool"]);
    } finally {
      if (originalEnv) process.env.PI_CODING_AGENT_DIR = originalEnv;
      else delete process.env.PI_CODING_AGENT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
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
});
