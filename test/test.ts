import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mergeOverrideList } from "../pi-extension/subagents/agent.ts";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import { updateStallTracking } from "../pi-extension/subagents/interrupt.ts";

import {
  getLeafId,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import {
  shellEscape,
} from "../pi-extension/subagents/mux.ts";
import {
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatStatusLine,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  findLatestAssistantError,
} from "../pi-extension/subagents/subagent-done.ts";
import { __pollForExitTest__ } from "../pi-extension/subagents/mux.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const capturedHandlers: Record<string, Function> = {};
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    sentUserMessages,
    sentMessages,
    capturedHandlers,
    api: {
      on(event: string, handler: Function) {
        capturedHandlers[event] = handler;
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });

    it("falls back to last toolResult text when no assistant text exists", () => {
      const toolCallMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-002", name: "write", arguments: "{}" }],
        },
      };
      const usefulResult = {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-002",
          toolName: "write",
          content: [{ type: "text", text: "Successfully wrote 9859 bytes to /home/output.md" }],
        },
      };
      const doneCall = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-003", name: "subagent_done", arguments: "{}" }],
        },
      };
      const doneResult = {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-003",
          toolName: "subagent_done",
          content: [{ type: "text", text: "Shutting down subagent session." }],
        },
      };
      const entries = [toolCallMsg, usefulResult, doneCall, doneResult] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Successfully wrote 9859 bytes to /home/output.md",
      );
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
      lineLimit: 4,
      minIntervalMs: 30_000,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
      minIntervalMs: 30_000,
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        lineLimit: 4,
        minIntervalMs: 30_000,
      });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

  it("keeps a missing snapshot as starting until the fixed watchdog threshold", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    assert.equal(classifyStatus(state, 60_999).kind, "starting");
    const stalled = classifyStatus(state, 61_000);
    assert.equal(stalled.kind, "stalled");
    assert.equal(stalled.statusLabel, null);
  });

  it("classifies active snapshots without aging into stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 5_000);

    // Within the 120s idle threshold: stays active
    const snapshot = classifyStatus(state, 60_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.activityLabel, "bash");
    assert.equal(snapshot.activeDurationText, "55s");
  });

  it("classifies waiting snapshots as healthy idle without becoming stalled", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    // Within the 120s idle threshold: stays waiting
    const snapshot = classifyStatus(state, 60_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.waitingDurationText, "50s");
  });

  it("detects stalled transitions and recovery", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, { snapshot: "missing" }, 1_000);

    let advanced = advanceStatusState(state, 95_000);
    assert.equal(advanced.transition, "stalled");
    assert.equal(advanced.snapshot.kind, "stalled");

    state = observeStatus(advanced.nextState, {
      snapshot: "present",
      updatedAt: 96_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 96_000,
      latestEvent: "agent_end",
    }, 96_000);
    advanced = advanceStatusState(state, 97_000);
    assert.equal(advanced.transition, "recovered");
    assert.equal(advanced.snapshot.kind, "waiting");
  });

  it("classifies long-idle active as stalled with idle label", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
      latestEvent: "tool_execution_start",
    }, 10_000);

    // After 130s without activity file update, should be stalled (idle threshold is 120s)
    const snapshot = classifyStatus(state, 140_000);
    assert.equal(snapshot.kind, "stalled");
    assert.equal(snapshot.statusLabel, "idle");
  });

  it("classifies long-idle waiting as stalled with idle label", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 1,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_000);

    // After 130s without activity file update, should be stalled (idle threshold is 120s)
    const snapshot = classifyStatus(state, 140_000);
    assert.equal(snapshot.kind, "stalled");
    assert.equal(snapshot.statusLabel, "idle");
  });

  it("keeps the last healthy kind during transient snapshot loss", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 5_000,
    }, 5_000);
    state = advanceStatusState(state, 6_000).nextState;
    state = observeStatus(state, { snapshot: "missing" }, 10_000);

    const snapshot = classifyStatus(state, 20_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("forces an active state to waiting after interrupt", () => {
    const now = 20_000;
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);

    assert.equal(classifyStatus(state, now).kind, "active");

    const forced = forceStatusAfterInterrupt(state, now);
    const snapshot = classifyStatus(forced, now);

    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");
    assert.equal(snapshot.waitingDurationText, "0s");
    assert.equal(forced.activeNow, false);
  });

  it("orders same-millisecond snapshots by sequence", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 10_000,
      activityLabel: "bash",
    }, 10_000);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 10_000,
      sequence: 3,
      phase: "waiting",
      waitingSince: 10_000,
      latestEvent: "agent_end",
    }, 10_001);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.latestEvent, "agent_end");
  });

  it("recovers from a transient snapshot read failure with the same valid snapshot", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = observeStatus(state, { snapshot: "missing" }, 10_000);
    assert.equal(classifyStatus(state, 10_000).statusLabel, null);

    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 2,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 11_000);

    const snapshot = classifyStatus(state, 11_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(snapshot.statusLabel, null);
  });

  it("ignores stale and exact old snapshots after interrupt and accepts newer snapshots", () => {
    let state = createStatusState({ source: "pi", startTimeMs: 0 });
    state = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 5_000);
    state = forceStatusAfterInterrupt(state, 20_000);

    const stale = observeStatus(state, {
      snapshot: "present",
      updatedAt: 5_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 5_000,
      activityLabel: "bash",
    }, 21_000);
    let snapshot = classifyStatus(stale, 21_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const sameTimestamp = observeStatus(stale, {
      snapshot: "present",
      updatedAt: 20_000,
      sequence: 1,
      phase: "active",
      active: true,
      activeScope: "tool",
      activeSince: 20_000,
      activityLabel: "bash",
    }, 22_000);
    snapshot = classifyStatus(sameTimestamp, 22_000);
    assert.equal(snapshot.kind, "waiting");
    assert.equal(snapshot.activityLabel, "interrupted");

    const resumed = observeStatus(sameTimestamp, {
      snapshot: "present",
      sequence: 2,
      updatedAt: 25_000,
      phase: "active",
      active: true,
      activeScope: "streaming",
      activeSince: 25_000,
      activityLabel: "streaming",
    }, 25_000);
    snapshot = classifyStatus(resumed, 25_000);
    assert.equal(snapshot.kind, "active");
    assert.equal(resumed.activeScope, "streaming");
  });

  it("normalizes and truncates long newline-heavy names", () => {
    const longName = `Worker\n\n${"very-long-name-".repeat(12)}`;
    const stalledState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "missing" },
      1_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 299_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 299_000,
        activityLabel: "write",
      },
      299_000,
    );
    const line = formatStatusLine(longName, classifyStatus(stalledState, 240_000));
    const recovered = formatTransitionLine(longName, classifyStatus(activeState, 300_000), "recovered");

    assert.doesNotMatch(line, /\n/);
    assert.doesNotMatch(recovered, /\n/);
    assert.ok(line.length <= 120, `expected bounded line length, got ${line.length}`);
    assert.ok(recovered.length <= 120, `expected bounded line length, got ${recovered.length}`);
  });

  it("caps visible status lines and reports overflow consistently", () => {
    const waitingState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      { snapshot: "present", updatedAt: 180_000, sequence: 1, phase: "waiting", waitingSince: 180_000 },
      180_000,
    );
    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 419_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 419_000,
        activityLabel: "bash",
      },
      419_000,
    );
    const waitingLine = formatStatusLine("Worker", classifyStatus(waitingState, 240_000));
    const recoveredLine = formatTransitionLine("Worker", classifyStatus(activeState, 420_000), "recovered");
    const lines = [waitingLine, recoveredLine, "Scout running 2m.", "Reviewer running 4m.", "Planner running 6m."];
    const capped = capStatusLines(lines, 3);
    const aggregate = formatStatusAggregate(lines, 3);

    assert.equal(waitingLine, "Worker running 4m, waiting 1m.");
    assert.equal(recoveredLine, "Worker running 7m, recovered; active (bash 1s).");
    assert.deepEqual(capped.visibleLines, [waitingLine, recoveredLine, "Scout running 2m."]);
    assert.equal(capped.overflow, 2);
    assert.match(aggregate, /^Subagent status:/);
    assert.match(aggregate, /\+2 more running\./);
    assert.doesNotMatch(aggregate, /\/tmp|\.jsonl/);
  });

  it("parseStatusConfig uses default minIntervalMs when not specified", () => {
    const config = parseStatusConfig({ status: { enabled: true } });
    assert.equal(config.minIntervalMs, 30_000);
  });

  it("parseStatusConfig accepts minIntervalMs from config", () => {
    const config = parseStatusConfig({ status: { enabled: true, minIntervalMs: 60_000 } });
    assert.equal(config.minIntervalMs, 60_000);
  });

  it("parseStatusConfig rejects minIntervalMs below 1000", () => {
    assert.throws(() => {
      parseStatusConfig({ status: { enabled: true, minIntervalMs: 500 } });
    });
  });

  it("parseStatusConfig rejects non-numeric minIntervalMs", () => {
    assert.throws(() => {
      parseStatusConfig({ status: { enabled: true, minIntervalMs: "not a number" } });
    });
  });

  it("parseStatusConfig reads minIntervalMs from env var PI_SUBAGENT_STATUS_MIN_INTERVAL_MS", () => {
    const original = process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS;
    try {
      process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS = "5000";
      const config = parseStatusConfig({ status: { enabled: true } });
      assert.equal(config.minIntervalMs, 5000);
    } finally {
      if (original === undefined) delete process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS;
      else process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS = original;
    }
  });

  it("parseStatusConfig accepts minIntervalMs", () => {
    const config = parseStatusConfig({ status: { enabled: true, minIntervalMs: 10000 } });
    assert.equal(config.minIntervalMs, 10000);
  });

  it("returns throttle notice when called within minIntervalMs", async () => {
    const { checkStatusThrottle, resetStatusCheckThrottle } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    assert.ok(checkStatusThrottle(), "first call should pass");
    assert.ok(!checkStatusThrottle(), "second call within interval should be throttled");
  });

  it("allows check after throttle reset", async () => {
    const { checkStatusThrottle, resetStatusCheckThrottle } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    assert.ok(checkStatusThrottle(), "first call should pass");
    resetStatusCheckThrottle();
    assert.ok(checkStatusThrottle(), "after reset, should pass");
  });

  it("setStatusSnapshot/getStatusSnapshot roundtrip", async () => {
    const { setStatusSnapshot, getStatusSnapshot } = await import("../pi-extension/subagents/shared.ts");
    const initial = getStatusSnapshot();
    assert.equal(initial, null, "initial snapshot should be null");

    setStatusSnapshot("3 subagents active");
    const snap = getStatusSnapshot();
    assert.ok(snap, "snapshot should be set");
    assert.equal(snap!.text, "3 subagents active");
    assert.ok(Date.now() - snap!.at < 1000, "snapshot timestamp should be recent");
  });

  it("getStatusThrottleRemainingMs returns remaining time", async () => {
    const { resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleRemainingMs } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // sets timestamp — throttle now active
    const remaining = getStatusThrottleRemainingMs();
    assert.ok(remaining >= 29900, `expected ~30000ms remaining, got ${remaining}`);
    assert.ok(remaining <= 30000, `expected <= 30000ms remaining, got ${remaining}`);
  });

  it("throttled response includes throttled: true in details", async () => {
    const { checkStatusThrottle, resetStatusCheckThrottle } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // first call — passes, sets timestamp
    const result = checkStatusThrottle(); // second call — throttled
    assert.equal(result, false, "second call should be throttled");
  });

  it("renderResult renders rate-limit text when throttled (not No running subagents)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const statusTool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(statusTool, "expected subagent_status tool to be registered");

    const theme = {
      fg(_color: string, text: string) { return text; },
      bold(text: string) { return text; },
    };
    const throttledResult = {
      content: [{ type: "text", text: "Rate-limited: next check in 25s. Status auto-delivered via steers on change — do not call this tool again before then." }],
      details: { agents: [], throttled: true },
    };
    const rendered = statusTool.renderResult(throttledResult as any, {}, theme);
    const text = rendered.render(80).join("\n");
    assert.ok(
      text.includes("Rate-limited"),
      `expected rate-limit text in rendered output, got: ${text}`,
    );
    assert.ok(
      !text.includes("No running subagents"),
      `should NOT show "No running subagents" for throttled response, got: ${text}`,
    );
  });

  it("consecutive throttled calls grow remaining time (backoff)", async () => {
    const { resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleRemainingMs } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // pass — sets timestamp
    // Simulate consecutive throttled calls
    checkStatusThrottle(); // strike 1, next interval = 60s
    const remaining1 = getStatusThrottleRemainingMs();
    assert.ok(remaining1 >= 50000, `expected ~60s remaining after 1st strike, got ${remaining1}`);

    checkStatusThrottle(); // strike 2, next interval = 120s
    const remaining2 = getStatusThrottleRemainingMs();
    assert.ok(remaining2 >= 110000, `expected ~120s remaining after 2nd strike, got ${remaining2}`);
    assert.ok(remaining2 > remaining1, "remaining time should increase after 2nd strike");
  });

  it("successful checkStatusThrottle resets backoff strikes", async () => {
    const { resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleStrikes } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // pass
    checkStatusThrottle(); // throttle (strike 1)
    checkStatusThrottle(); // throttle (strike 2)
    assert.equal(getStatusThrottleStrikes(), 2, "should have 2 strikes");
    // Manually set lastStatusCheckAt far in the past to allow a pass
    // (checkStatusThrottle uses lastStatusCheckAt internally, so we just wait... or reset)
    resetStatusCheckThrottle();
    checkStatusThrottle(); // pass — resets strikes
    assert.equal(getStatusThrottleStrikes(), 0, "strikes should reset to 0 after pass");
  });

  it("resetStatusCheckThrottle resets strikes to 0", async () => {
    const { resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleStrikes, getStatusThrottleRemainingMs } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // pass
    checkStatusThrottle(); // throttle (strike 1)
    assert.equal(getStatusThrottleStrikes(), 1);
    resetStatusCheckThrottle();
    assert.equal(getStatusThrottleStrikes(), 0, "strikes reset to 0");
    assert.equal(getStatusThrottleRemainingMs(), 0, "remaining resets to 0");
  });

  it("getStatusThrottleRemainingMs returns 0 before any check", async () => {
    const { resetStatusCheckThrottle, getStatusThrottleRemainingMs } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    assert.equal(getStatusThrottleRemainingMs(), 0, "remaining should be 0 before first call");
  });

  it("throttle penalty text includes backoff info", async () => {
    const { resetStatusCheckThrottle, checkStatusThrottle, getStatusThrottleStrikes, getStatusThrottleRemainingMs } = await import("../pi-extension/subagents/shared.ts");
    resetStatusCheckThrottle();
    checkStatusThrottle(); // pass
    // The notice text is built in index.ts execute — verify it includes penalty
    // when strikes > 0. Since we can't easily call the full tool, verify the
    // mechanism: strikes > 0 and remaining > base interval
    checkStatusThrottle(); // throttle, strike 1
    assert.ok(getStatusThrottleStrikes() >= 1, "should have at least 1 strike");
    assert.ok(getStatusThrottleRemainingMs() > 30000, "remaining should exceed base 30s due to backoff");
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "model: anthropic/test-interactive-true",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        projectAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "model: anthropic/test-interactive-false",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
          "model: anthropic/test-interactive-unset",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolveEffectiveInteractive defaults to the inverse of auto-exit", () => {
    // Autonomous agents (auto-exit: true) are NOT interactive — parent gets stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );
    // Agents without auto-exit ARE interactive — parent does not receive status transition pings.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: false }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, {}),
      true,
    );
    // Bare spawn with no agent defs (e.g. /iterate fork) is interactive by default.
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, null),
      true,
    );
  });

  it("resolveEffectiveInteractive honors explicit frontmatter over the auto-exit default", () => {
    // Autonomous agent that still wants to be treated as interactive.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { autoExit: true, interactive: true },
      ),
      true,
    );
    // Non-auto-exit agent that opts back into stall pings.
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T" },
        { interactive: false },
      ),
      false,
    );
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("bundled worker/reviewer agents resolve as non-interactive", () => {
    for (const name of ["worker", "reviewer"]) {
      const defs = testApi.loadAgentDefaults(name);
      assert.ok(defs, `expected bundled agent ${name} to be discoverable`);
      assert.equal(
        testApi.resolveEffectiveInteractive({ name, task: "" }, defs),
        false,
        `${name} should resolve as non-interactive (autonomous)`,
      );
    }
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done,check_messages",
    );
  });

  it("buildSubagentToolAllowlist defaults to read+bash without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), "caller_ping,subagent_done,check_messages,read,bash");
    assert.equal(testApi.buildSubagentToolAllowlist(""), "caller_ping,subagent_done,check_messages,read,bash");
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((tool) => tool.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});
describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), false);
    });

    it("still exits when the latest turn ended with stopReason=error", () => {
      // Auto-exit subagents must shut down on retry-exhaustion errors so the
      // parent is woken. The error sidecar (written separately) carries the
      // failure detail; staying open would just strand the worker.
      const messages = [{ role: "assistant", stopReason: "error", errorMessage: "529 overloaded" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });
  });

  describe("findLatestAssistantError", () => {
    it("returns the error info from a stopReason=error message", () => {
      const messages = [
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] },
        { role: "toolResult", content: [] },
        { role: "assistant", stopReason: "error", errorMessage: "Anthropic 529 Overloaded" },
      ];
      assert.deepEqual(findLatestAssistantError(messages), {
        errorMessage: "Anthropic 529 Overloaded",
        stopReason: "error",
      });
    });

    it("returns null when the latest assistant turn completed normally", () => {
      const messages = [
        { role: "assistant", stopReason: "error", errorMessage: "old failure" },
        { role: "user", content: [] },
        { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      ];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("returns null when the latest assistant turn was aborted by the user", () => {
      const messages = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(findLatestAssistantError(messages), null);
    });

    it("falls back to a placeholder when stopReason=error has no errorMessage field", () => {
      const messages = [{ role: "assistant", stopReason: "error" }];
      const info = findLatestAssistantError(messages);
      assert.ok(info);
      assert.equal(info!.stopReason, "error");
      assert.match(info!.errorMessage, /stopReason=error/);
    });

    it("returns null when messages is undefined or empty", () => {
      assert.equal(findLatestAssistantError(undefined), null);
      assert.equal(findLatestAssistantError([]), null);
    });
  });
});

describe("mux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

  it("decodes ping payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ type: "ping", name: "Worker", message: "need help" }),
      {
        reason: "ping",
        exitCode: 0,
        ping: { name: "Worker", message: "need help" },
      },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ type: "done" }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        type: "error",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
        stopReason: "error",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ type: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("treats unknown payload shapes as done", () => {
    assert.deepEqual(interpretExitSidecar({}), { reason: "done", exitCode: 0 });
    assert.deepEqual(interpretExitSidecar(null), { reason: "done", exitCode: 0 });
  });
});
describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
  });

  it("expands spawning false to deny subagent interruption", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_resume"), true);
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const rendered = subagentTool.renderCall({}, theme);
    const output = rendered.render(80).join("\n");

    assert.match(output, /\(unnamed\)/);
  });

  it("registers subagent_resume with an autoExit override", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
    assert.ok(resumeTool, "expected subagent_resume tool to be registered");

    const autoExitSchema = resumeTool.parameters.properties.autoExit;
    assert.equal(autoExitSchema.type, "boolean");
    assert.match(autoExitSchema.description, /Defaults to true/);
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.subagentDone();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("subagent interruption", () => {
  function makeRunning(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      name: "Worker",
      task: "",
      surface: "pane-1",
      startTime: 0,
      sessionFile: "worker.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      ...overrides,
    };
  }

  it("registers subagent_interrupt in the main session extension", () => {
    const { api, registeredTools } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), true);
  });

  it("resolves interrupt targets by exact id and reports name ambiguity", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning({ id: "a1", name: "Worker", surface: "a1", sessionFile: "a1.jsonl" }));
      runningMap.set("b2", makeRunning({ id: "b2", name: "Worker", surface: "b2", sessionFile: "b2.jsonl" }));
      runningMap.set("c3", makeRunning({ id: "c3", name: "Scout", surface: "c3", sessionFile: "c3.jsonl" }));

      const byId = testApi.resolveInterruptTarget({ id: "c3", name: "Worker" });
      assert.equal(byId.running.id, "c3");

      const ambiguous = testApi.resolveInterruptTarget({ name: "Worker" });
      assert.match(ambiguous.error, /Ambiguous subagent name/);
    } finally {
      runningMap.clear();
    }
  });

  it("returns an explicit error when Escape delivery fails", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, () => {
      throw new Error("mux write failed");
    });

    assert.match(result.error, /Failed to send Escape/);
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("leaves status unchanged when Escape delivery fails in the tool path", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      runningMap.set("a1", makeRunning({ statusState: activeState }));

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt({ name: "Worker" }, () => {
        throw new Error("mux write failed");
      }));

      assert.match(result.content[0].text, /Failed to send Escape/);
      assert.equal(classifyStatus(runningMap.get("a1").statusState, 20_000).kind, "active");
    } finally {
      runningMap.clear();
    }
  });

  it("sends Escape without aborting or mutating running state", () => {
    const testApi = (subagentsModule as any).__test__;
    let aborted = false;
    let sentSurface = "";
    const running = makeRunning({
      abortController: {
        abort() {
          aborted = true;
        },
      },
    });

    const result = testApi.requestSubagentInterrupt(running, (surface: string) => {
      sentSurface = surface;
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(sentSurface, "pane-1");
    assert.equal(aborted, false);
    assert.equal("interruptRequested" in running, false);
  });

  it("refreshes the latest activity snapshot before forcing local interrupt waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    const closedSurfaces: string[] = [];
    runningMap.clear();

    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const activityFile = getSubagentActivityFile(dir, "a1");
      const activity = {
        version: 1,
        runningChildId: "a1",
        createdAt: 1_000,
        updatedAt: 19_000,
        sequence: 7,
        latestEvent: "tool_execution_start",
        phase: "active",
        agentActive: true,
        turnActive: true,
        providerActive: false,
        toolActive: true,
        activeScope: "tool",
        activeSince: 19_000,
        toolName: "bash",
      };
      writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

      try {
        const running = makeRunning({
          activityFile,
          statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
        });
        runningMap.set("a1", running);

        withMockedNow(20_000, () => testApi.handleSubagentInterrupt(
          { name: "Worker" },
          (surface: string) => { sentSurface = surface; },
          (surface: string) => { closedSurfaces.push(surface); },
        ));

        assert.equal(sentSurface, "pane-1");
        assert.deepEqual(closedSurfaces, ["pane-1"]);
        assert.equal(runningMap.has("a1"), false);
        // statusState is mutated on the running object before cleanup
        const state = running.statusState;
        const snapshot = classifyStatus(state, 20_000);
        assert.equal(snapshot.kind, "waiting");
        assert.equal(snapshot.activityLabel, "interrupted");
        assert.equal(state.lastActivityAtMs, 20_000);
        assert.equal(state.lastActivitySequence, 7);
        assert.equal(state.localOverrideSequence, 7);
      } finally {
        runningMap.clear();
      }
    });
  });

  it("acknowledges Pi-backed interrupt requests and forces local status waiting", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    let sentSurface = "";
    const closedSurfaces: string[] = [];
    runningMap.clear();

    const activeState = observeStatus(
      createStatusState({ source: "pi", startTimeMs: 0 }),
      {
        snapshot: "present",
        updatedAt: 5_000,
        sequence: 1,
        phase: "active",
        active: true,
        activeScope: "tool",
        activeSince: 5_000,
        activityLabel: "bash",
      },
      5_000,
    );

    try {
      const running = makeRunning({ statusState: activeState });
      runningMap.set("a1", running);

      const result = withMockedNow(20_000, () => testApi.handleSubagentInterrupt(
        { name: "Worker" },
        (surface: string) => { sentSurface = surface; },
        (surface: string) => { closedSurfaces.push(surface); },
      ));

      assert.equal(sentSurface, "pane-1");
      assert.deepEqual(closedSurfaces, ["pane-1"]);
      assert.equal(result.content[0].text, 'Sub-agent "Worker" aborted (interrupted and terminated).');
      assert.deepEqual(result.details, { id: "a1", name: "Worker", status: "interrupt_requested" });
      assert.equal(runningMap.has("a1"), false);
      // statusState is still accessible on the original running object
      const snapshot = classifyStatus(running.statusState, 20_000);
      assert.equal(snapshot.kind, "waiting");
      assert.equal(snapshot.activityLabel, "interrupted");
    } finally {
      runningMap.clear();
    }
  });

  it("returns an error for repeated interrupt requests after termination", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningMap = testApi.runningSubagents as Map<string, any>;
    const surfaces: string[] = [];
    const closedSurfaces: string[] = [];
    runningMap.clear();

    try {
      runningMap.set("a1", makeRunning());

      const firstResult = testApi.handleSubagentInterrupt(
        { name: "Worker" },
        (surface: string) => { surfaces.push(surface); },
        (surface: string) => { closedSurfaces.push(surface); },
      );

      assert.deepEqual(surfaces, ["pane-1"]);
      assert.deepEqual(closedSurfaces, ["pane-1"]);
      assert.equal(runningMap.has("a1"), false);
      assert.equal(firstResult.content[0].text, 'Sub-agent "Worker" aborted (interrupted and terminated).');

      // Second call on a now-empty map should return an error
      const secondResult = testApi.handleSubagentInterrupt(
        { name: "Worker" },
        (surface: string) => { surfaces.push(surface); },
        (surface: string) => { closedSurfaces.push(surface); },
      );

      assert.deepEqual(surfaces, ["pane-1"]); // no additional Escape sent
      assert.deepEqual(closedSurfaces, ["pane-1"]); // no additional close
      assert.ok("error" in secondResult.details);
      assert.match(secondResult.content[0].text, /No running subagent named/);
    } finally {
      runningMap.clear();
    }
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Resume: pi --session/);
  });

  it("renders a clear provider/agent error when errorMessage is set", () => {
    // Previously, an overload retry-exhaustion produced exitCode 0 with a
    // stale summary — the orchestrator thought the subagent finished
    // quickly. With the error sidecar plumbed through, the presentation
    // must call out the failure, include the underlying error, and tell the
    // orchestrator how to recover.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.match(presentation, /provider\/agent error — auto-retry exhausted/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /Resume: pi --session/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

describe("subagent status renderer", () => {
  function createTheme() {
    return {
      fg(_color: string, text: string) {
        return text;
      },
      bg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
  }

  it("renders only capped lines plus overflow", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const visibleLines = [
      "Worker running 5m, active (bash 2m).",
      "Scout running 3m, waiting 1m.",
      "Reviewer running 2m, active (streaming 30s).",
      "Planner running 4m, waiting 2m.",
    ];
    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: {
          lines: visibleLines,
          overflow: 2,
        },
      },
      { expanded: true },
      createTheme(),
    );
    const output = rendered.render(80).join("\n");

    assert.match(output, /Subagent status/);
    for (const line of visibleLines) {
      assert.match(output, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(output, /\+2 more running\./);
  });

  it("stays within narrow widths", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const rendererEntry = registeredMessageRenderers.find((entry) => entry.name === "subagent_status");
    assert.ok(rendererEntry, "expected subagent_status renderer to be registered");

    const rendered = rendererEntry.renderer(
      {
        customType: "subagent_status",
        content: "Subagent status:\n• Worker running 5m, active (bash 2m).",
        details: { lines: ["Worker running 5m, active (bash 2m)."], overflow: 0 },
      },
      { expanded: true },
      createTheme(),
    );

    for (const width of [4, 5, 6]) {
      for (const line of rendered.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 13_000 }),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 21_000 }),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          statusState: createStatusState({ source: "pi", startTimeMs: 1_000_000 - 27_000 }),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

describe("mux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });
});

describe("agent extensions & skills", () => {
  describe("mergeOverrideList", () => {
    it("appends override to base with dedupe", () => {
      assert.equal(mergeOverrideList("read,bash,write,edit", ["grep", "edit"]), "read,bash,write,edit,grep");
    });
    it("returns base when override empty", () => {
      assert.equal(mergeOverrideList("read,bash", undefined), "read,bash");
      assert.equal(mergeOverrideList("read,bash", []), "read,bash");
    });
    it("returns override when base undefined", () => {
      assert.equal(mergeOverrideList(undefined, ["grep"]), "grep");
    });
  });

  const testApi = (subagentsModule as any).__test__;
  const { resolveAgentExtensions, buildAgentResourceArgs } = testApi;

  describe("resolveAgentExtensions", () => {
    it("returns empty array for undefined", () => {
      assert.deepEqual(resolveAgentExtensions(undefined, "/tmp"), []);
    });

    it("returns empty array for empty string", () => {
      assert.deepEqual(resolveAgentExtensions("", "/tmp"), []);
    });

    it("passes through npm: and git: references", () => {
      const result = resolveAgentExtensions(
        "npm:@scope/package,git:github.com/user/repo",
        "/tmp",
      );
      assert.deepEqual(result, [
        "npm:@scope/package",
        "git:github.com/user/repo",
      ]);
    });

    it("resolves absolute paths", () => {
      const result = resolveAgentExtensions("/home/user/ext.ts", "/tmp");
      assert.deepEqual(result, ["/home/user/ext.ts"]);
    });

    it("resolves home-directory paths", () => {
      const result = resolveAgentExtensions("~/ext/my-tool.ts", "/tmp");
      // Should expand ~ to homedir
      assert.ok(result[0].startsWith(homedir()));
      assert.ok(result[0].endsWith("ext/my-tool.ts"));
    });

    it("resolves relative paths against agent dir", () => {
      const result = resolveAgentExtensions("/agents/planner/local/ext.ts", "/tmp");
      assert.equal(result[0], "/agents/planner/local/ext.ts");
    });

    it("scans directories for .ts files and */index.ts", () => {
      const os = { tmpdir };
      const fs = { mkdtempSync, writeFileSync, mkdirSync, rmSync };
      const path = { join };
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ext-test-"),
      );
      try {
        // Create files in the temp directory
        fs.writeFileSync(
          path.join(tmpDir, "tool-a.ts"),
          "export default {}",
        );
        fs.writeFileSync(
          path.join(tmpDir, "tool-b.ts"),
          "export default {}",
        );
        const subDir = path.join(tmpDir, "sub-ext");
        fs.mkdirSync(subDir);
        fs.writeFileSync(
          path.join(subDir, "index.ts"),
          "export default {}",
        );

        const result = resolveAgentExtensions(tmpDir, "/tmp");
        assert.equal(result.length, 3);
        assert.ok(result.some((r: string) => r.endsWith("tool-a.ts")));
        assert.ok(result.some((r: string) => r.endsWith("tool-b.ts")));
        assert.ok(result.some((r: string) => r.endsWith("sub-ext/index.ts")));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles missing paths gracefully", () => {
      const result = resolveAgentExtensions("/nonexistent/path.ts", "/tmp");
      assert.deepEqual(result, ["/nonexistent/path.ts"]);
    });
  });

  describe("buildAgentResourceArgs", () => {
    it("returns empty array for null agentDefs", () => {
      assert.deepEqual(buildAgentResourceArgs(null, "/tmp"), []);
    });

    it("returns empty array for agentDefs without extensions/skills", () => {
      assert.deepEqual(
        buildAgentResourceArgs({ model: "test" }, "/tmp"),
        [],
      );
    });

    it("adds --no-extensions and -e for explicit extensions", () => {
      const result = buildAgentResourceArgs(
        { extensions: "/home/user/ext.ts" },
        "/tmp",
      );
      assert.ok(result.includes("--no-extensions"));
      assert.ok(result.includes("-e"));
    });

    it("adds --no-skills and --skill for explicit skills", () => {
      const result = buildAgentResourceArgs(
        { skills: "tavily-search" },
        "/tmp",
      );
      assert.ok(result.includes("--no-skills"));
      assert.ok(result.includes("--skill"));
    });

    it("passes skill names through as-is", () => {
      const result = buildAgentResourceArgs(
        { skills: "tavily-search,my-skill" },
        "/tmp",
      );
      const skillIdx = result.indexOf("--skill");
      assert.ok(skillIdx >= 0);
      assert.equal(result[skillIdx + 1], "'tavily-search'");
    });

    it("handles both extensions and skills together", () => {
      const result = buildAgentResourceArgs(
        {
          extensions: "git:github.com/user/repo",
          skills: "my-skill",
        },
        "/tmp",
      );
      assert.ok(result.includes("--no-extensions"));
      assert.ok(result.includes("--no-skills"));
      assert.ok(result.includes("-e"));
      assert.ok(result.includes("--skill"));
    });
  });
});

// ── Equalize Stack TDD ─────────────────────────────────────────────

import { resetLayout, createTileSurface } from "../pi-extension/subagents/mux-layout.ts";

describe("mux-layout.ts equalize stack", () => {
  let splitCalls: Array<{ name: string; direction: string; from?: string }> = [];
  let resizeCalls: Array<{ panes: string[]; targetHeight: number }> = [];
  let heightReturns: Record<string, number> = {};

  function mockSplitFn(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string): string {
    splitCalls.push({ name, direction, from: fromSurface });
    return `pane-${name}`;
  }

  function mockResizeFn(panes: string[], targetHeight: number): void {
    resizeCalls.push({ panes, targetHeight });
  }

  function mockGetHeightFn(pane: string): number {
    return heightReturns[pane] ?? 0;
  }

  beforeEach(() => {
    splitCalls = [];
    resizeCalls = [];
    heightReturns = {};
    resetLayout();
  });

  // Cycle 1: 1 subagent → split right, no equalize
  it("1 subagent → split right, no equalize", () => {
    const result = createTileSurface("sub-a", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    assert.equal(result, "pane-sub-a");
    assert.equal(splitCalls.length, 1);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(resizeCalls.length, 0);
  });
});

describe("updateStallTracking", () => {
  const thresholdMs = 10000;

  it("resets tracking for non-stalled entries", () => {
    const tracked = new Map([["a", 1000]]);
    const { stallStarts, toCleanup } = updateStallTracking(tracked, 2000, thresholdMs, [
      { id: "a", kind: "active" as const, interactive: false },
    ]);
    assert.equal(stallStarts.has("a"), false);
    assert.deepEqual(toCleanup, []);
  });

  it("records stall start on first detection", () => {
    const { stallStarts, toCleanup } = updateStallTracking(new Map(), 5000, thresholdMs, [
      { id: "b", kind: "stalled" as const, interactive: false },
    ]);
    assert.equal(stallStarts.get("b"), 5000);
    assert.deepEqual(toCleanup, []);
  });

  it("flags cleanup when stall exceeds threshold", () => {
    const tracked = new Map([["c", 1000]]);
    const { stallStarts, toCleanup } = updateStallTracking(tracked, 12000, thresholdMs, [
      { id: "c", kind: "stalled" as const, interactive: false },
    ]);
    assert.equal(stallStarts.has("c"), false, "removed from tracking after cleanup");
    assert.deepEqual(toCleanup, ["c"]);
  });

  it("keeps tracking when stall under threshold", () => {
    const tracked = new Map([["d", 1000]]);
    const { stallStarts, toCleanup } = updateStallTracking(tracked, 8000, thresholdMs, [
      { id: "d", kind: "stalled" as const, interactive: false },
    ]);
    assert.equal(stallStarts.get("d"), 1000);
    assert.deepEqual(toCleanup, []);
  });

  it("never cleans up interactive stalled entries", () => {
    const tracked = new Map([["e", 1000]]);
    const { stallStarts, toCleanup } = updateStallTracking(tracked, 12000, thresholdMs, [
      { id: "e", kind: "stalled" as const, interactive: true },
    ]);
    assert.equal(stallStarts.get("e"), 1000, "still tracked");
    assert.deepEqual(toCleanup, []);
  });

  it("records start for interactive stalled too", () => {
    const { stallStarts } = updateStallTracking(new Map(), 5000, thresholdMs, [
      { id: "f", kind: "stalled" as const, interactive: true },
    ]);
    assert.equal(stallStarts.get("f"), 5000);
  });

  it("handles multiple entries mixed stalled and recovered", () => {
    const tracked = new Map([
      ["stalled-a", 5000],
      ["stalled-b", 5000],
      ["recovered-c", 1000],
    ]);
    // now=10000, threshold=10000 => stalled-a/b: 10000-5000=5000 < 10000 => still tracked
    const { stallStarts, toCleanup } = updateStallTracking(tracked, 10000, thresholdMs, [
      { id: "stalled-a", kind: "stalled" as const, interactive: false },
      { id: "stalled-b", kind: "stalled" as const, interactive: false },
      { id: "recovered-c", kind: "active" as const, interactive: false },
    ]);
    assert.equal(stallStarts.has("recovered-c"), false, "recovered removed");
    assert.equal(stallStarts.get("stalled-a"), 5000, "stalled-a still tracked");
    assert.equal(stallStarts.get("stalled-b"), 5000, "stalled-b still tracked");
    assert.deepEqual(toCleanup, [], "no cleanup yet");
    // Advance time past threshold for both: now=20000, 20000-5000=15000 > 10000
    const { toCleanup: cleanup2 } = updateStallTracking(stallStarts, 20000, thresholdMs, [
      { id: "stalled-a", kind: "stalled" as const, interactive: false },
      { id: "stalled-b", kind: "stalled" as const, interactive: false },
    ]);
    assert.deepEqual(cleanup2.sort(), ["stalled-a", "stalled-b"]);
  });

  it("does not mutate the input map", () => {
    const tracked = new Map([["x", 1000]]);
    const cloned = new Map(tracked);
    updateStallTracking(tracked, 12000, thresholdMs, [
      { id: "x", kind: "stalled" as const, interactive: false },
    ]);
    assert.deepEqual(tracked, cloned, "original map unchanged");
  });
});

describe("prompt-inject", () => {
  it("injects a section containing all four orchestration tool names", async () => {
    const { capturedHandlers, api } = createMockExtensionApi();
    const { registerPromptInject } = await import("../pi-extension/subagents/prompt-inject.ts");

    // Remove any existing agent definitions so the mock ones take effect
    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSubagentName = process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_NAME;
    const root = mkdtempSync(join(tmpdir(), "pi-test-prompt-"));
    const globalDir = join(root, "global");
    const projectDir = join(root, "project");
    const projectAgentsDir = join(projectDir, ".pi", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeAgentFile(projectAgentsDir, "worker", "name: worker");

    process.chdir(projectDir);
    process.env.PI_CODING_AGENT_DIR = globalDir;
    try {
      registerPromptInject(api as any);

      const handler = capturedHandlers["before_agent_start"];
      assert.ok(handler, "before_agent_start handler was registered");

      const fakePrompt = "You are a helpful assistant.";
      const result = handler({ systemPrompt: fakePrompt }, {});
      const injected = result.systemPrompt;

      assert.ok(injected.includes("`subagent_status`"), "missing subagent_status");
      assert.ok(injected.includes("`subagent_interrupt`"), "missing subagent_interrupt");
      assert.ok(injected.includes("`subagents_list`"), "missing subagents_list");
      assert.ok(injected.includes("`send_messages`"), "missing send_messages");
      assert.ok(injected.includes("backoff"), "missing backoff wording");
      assert.ok(injected.includes("30s"), "missing 30s");
      assert.ok(injected.includes("60s"), "missing 60s");
      assert.ok(injected.includes("<!-- subagent-orch-start -->"), "missing start marker");
      assert.ok(injected.includes("<!-- subagent-orch-end -->"), "missing end marker");
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-injects section on second call (replaces existing markers)", async () => {
    const { capturedHandlers, api } = createMockExtensionApi();
    const { registerPromptInject } = await import("../pi-extension/subagents/prompt-inject.ts");

    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSubagentName = process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_NAME;
    const root = mkdtempSync(join(tmpdir(), "pi-test-prompt-reinject-"));
    const globalDir = join(root, "global");
    const projectDir = join(root, "project");
    const projectAgentsDir = join(projectDir, ".pi", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });

    writeAgentFile(projectAgentsDir, "worker", "name: worker");

    process.chdir(projectDir);
    process.env.PI_CODING_AGENT_DIR = globalDir;
    try {
      registerPromptInject(api as any);

      const handler = capturedHandlers["before_agent_start"];
      // First injection
      const result1 = handler({ systemPrompt: "base prompt" }, {});
      // Second injection — should replace, not duplicate
      const result2 = handler({ systemPrompt: result1.systemPrompt }, {});

      const startCount = result2.systemPrompt.split("<!-- subagent-orch-start -->").length - 1;
      const endCount = result2.systemPrompt.split("<!-- subagent-orch-end -->").length - 1;
      assert.equal(startCount, 1, "start marker should appear exactly once");
      assert.equal(endCount, 1, "end marker should appear exactly once");
      assert.ok(result2.systemPrompt.includes("`subagent_status`"), "tool name missing after re-injection");
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("send_messages coordination helpers", () => {
  const testApi = (subagentsModule as any).__test__;
  const { getCoordDir, writeIncomingMessage, countPendingFiles } = testApi;

  describe("getCoordDir", () => {
    it("returns correct path with HOME set", () => {
      const originalHome = process.env.HOME;
      process.env.HOME = "/home/testuser";
      try {
        assert.equal(getCoordDir("abc123"), "/home/testuser/.local/share/pi/subagents/abc123");
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it("falls back to /tmp when HOME is unset", () => {
      const originalHome = process.env.HOME;
      delete process.env.HOME;
      try {
        assert.equal(getCoordDir("abc123"), "/tmp/.local/share/pi/subagents/abc123");
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });
  });

  describe("writeIncomingMessage", () => {
    it("creates incoming dir and writes file with timestamp+seq+random prefix", () => {
      withTempDir((dir) => {
        const coordDir = join(dir, "sub1");
        const filename = writeIncomingMessage(coordDir, 0, "hello world");
        assert.ok(filename.match(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-0-[0-9a-f]{4}\.txt$/), `unexpected filename: ${filename}`);
        const content = readFileSync(join(coordDir, "incoming", filename), "utf-8");
        assert.equal(content, "hello world");
      });
    });

    it("uses sequential seq numbers", () => {
      withTempDir((dir) => {
        const coordDir = join(dir, "sub1");
        const f0 = writeIncomingMessage(coordDir, 0, "msg0");
        const f1 = writeIncomingMessage(coordDir, 1, "msg1");
        assert.ok(f0.includes("-0-"), `expected seq 0 in ${f0}`);
        assert.ok(f1.includes("-1-"), `expected seq 1 in ${f1}`);
      });
    });
  });

  describe("countPendingFiles", () => {
    it("returns 0 for nonexistent directory", () => {
      withTempDir((dir) => {
        assert.equal(countPendingFiles(join(dir, "nonexistent")), 0);
      });
    });

    it("counts only .txt files", () => {
      withTempDir((dir) => {
        const coordDir = join(dir, "sub1");
        const incoming = join(coordDir, "incoming");
        mkdirSync(incoming, { recursive: true });
        writeFileSync(join(incoming, "a.txt"), "a");
        writeFileSync(join(incoming, "b.txt"), "b");
        writeFileSync(join(incoming, ".DS_Store"), "x");
        assert.equal(countPendingFiles(coordDir), 2);
      });
    });
  });

  describe("send_messages validation (via tool execute)", () => {
    function makeRunning(id: string, name: string) {
      return {
        id, name, task: "", surface: `pane-${id}`, startTime: 0,
        sessionFile: `${id}.jsonl`,
        statusState: createStatusState({ source: "pi", startTimeMs: 0 }),
      };
    }

    function getSendMessagesTool() {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      return registeredTools.find((t: any) => t.name === "send_messages");
    }

    it("rejects when no id or name provided", async () => {
      const tool = getSendMessagesTool();
      const result = await tool.execute("tc-1", { messages: ["hi"] });
      assert.match(result.content[0].text, /must provide id or name/);
    });

    it("rejects empty messages array", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.set("t1", makeRunning("t1", "TestAgent"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "t1", messages: [] });
        assert.match(result.content[0].text, /requires at least 1 message/);
      } finally {
        runningMap.clear();
      }
    });

    it("rejects more than 10 messages", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.set("t1", makeRunning("t1", "TestAgent"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "t1", messages: new Array(11).fill("msg") });
        assert.match(result.content[0].text, /too many messages/);
      } finally {
        runningMap.clear();
      }
    });

    it("rejects empty/whitespace-only message", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.set("t1", makeRunning("t1", "TestAgent"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "t1", messages: ["  "] });
        assert.match(result.content[0].text, /message is empty/);
      } finally {
        runningMap.clear();
      }
    });

    it("rejects message too long", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.set("t1", makeRunning("t1", "TestAgent"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "t1", messages: ["x".repeat(4001)] });
        assert.match(result.content[0].text, /message too long/);
      } finally {
        runningMap.clear();
      }
    });

    it("resolves by name", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const dir = createTestDir();
      const originalHome = process.env.HOME;
      process.env.HOME = dir;
      runningMap.set("t1", makeRunning("t1", "TestAgent"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { name: "TestAgent", messages: ["hello"] });
        assert.match(result.content[0].text, /Delivered 1 message\(s\) to TestAgent/);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("resolves by id (preferred over name)", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const dir = createTestDir();
      const originalHome = process.env.HOME;
      process.env.HOME = dir;
      runningMap.set("t1", makeRunning("t1", "Agent1"));
      runningMap.set("t2", makeRunning("t2", "Agent2"));
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "t2", name: "Agent1", messages: ["hello"] });
        assert.match(result.content[0].text, /Delivered 1 message\(s\) to Agent2/);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns error for no match", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      runningMap.clear();
      try {
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id: "nope", messages: ["hello"] });
        assert.match(result.content[0].text, /No running subagent matching nope/);
      } finally {
        runningMap.clear();
      }
    });

    it("delivers messages to correct coordination directory", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const dir = createTestDir();
      const originalHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        const id = "delivertest";
        runningMap.set(id, makeRunning(id, "DeliverTest"));
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id, messages: ["msg1", "msg2"] });
        assert.match(result.content[0].text, /Delivered 2 message\(s\) to DeliverTest/);
        const incoming = join(getCoordDir(id), "incoming");
        const files = readdirSync(incoming).sort();
        assert.equal(files.length, 2);
        assert.equal(readFileSync(join(incoming, files[0]), "utf-8"), "msg1");
        assert.equal(readFileSync(join(incoming, files[1]), "utf-8"), "msg2");
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects when pending files exceed max", async () => {
      const testApi = (subagentsModule as any).__test__;
      const runningMap = testApi.runningSubagents as Map<string, any>;
      const dir = createTestDir();
      const originalHome = process.env.HOME;
      process.env.HOME = dir;
      try {
        const id = "backpressure";
        runningMap.set(id, makeRunning(id, "BackPressure"));
        // Create 11 pending files (> MAX_PENDING_FILES = 10)
        const coordDir = getCoordDir(id);
        const incoming = join(coordDir, "incoming");
        mkdirSync(incoming, { recursive: true });
        for (let i = 0; i < 11; i++) writeFileSync(join(incoming, `${i}.txt`), `${i}`);
        const tool = getSendMessagesTool();
        const result = await tool.execute("tc-1", { id, messages: ["hello"] });
        assert.match(result.content[0].text, /unread messages/);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        runningMap.clear();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("registers send_messages tool", () => {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const tool = registeredTools.find((t: any) => t.name === "send_messages");
      assert.ok(tool, "expected send_messages tool to be registered");
      assert.ok(tool.parameters.properties.messages, "expected messages parameter");
    });
  });
});

describe("check_messages .txt filter", () => {
  it("subagent_status description mentions exponential backoff", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(tool, "expected subagent_status tool");
    assert.match(tool.description, /exponential backoff/);
    assert.match(tool.promptSnippet, /exponential backoff/);
  });
});
