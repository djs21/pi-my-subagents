import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mergeOverrideList } from "../pi-extension/subagents/agent.ts";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../pi-extension/subagents/index.ts";

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
  stripAnsi,
  cleanTerminalOutput,
} from "../pi-extension/subagents/mux.ts";
import {
  handleSubagentPeek,
  handleSubagentSteer,
} from "../pi-extension/subagents/interrupt.ts";
import {
  ORCHESTRATOR_TOOLS,
  type RunningSubagent,
} from "../pi-extension/subagents/types.ts";
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
  formatSubagentToolsWidget,
} from "../pi-extension/subagents/subagent-done.ts";
import subagentDoneExtension from "../pi-extension/subagents/subagent-done.ts";
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
  const registeredShortcuts: Array<{ key: string; options: any }> = [];
  const registeredMessageRenderers: Array<any> = [];
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  const capturedHandlers: Record<string, Function> = {};
  return {
    registeredTools,
    registeredCommands,
    registeredShortcuts,
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
      registerShortcut(key: string, options: any) {
        registeredShortcuts.push({ key, options });
      },
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
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../config.json.example", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
      lineLimit: 4,
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

  it("parseStatusConfig omits minIntervalMs from the parsed config", () => {
    const config = parseStatusConfig({ status: { enabled: true } });
    assert.deepEqual(config, { enabled: true, lineLimit: 4 });
    assert.equal("minIntervalMs" in config, false, "minIntervalMs should no longer exist");
  });

  it("parseStatusConfig rejects the removed minIntervalMs key", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, minIntervalMs: 60_000 } }),
      /status has unsupported key\(s\): minIntervalMs/,
    );
  });

  it("PI_SUBAGENT_STATUS_MIN_INTERVAL_MS no longer affects config", () => {
    const original = process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS;
    try {
      process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS = "5000";
      const config = parseStatusConfig({ status: { enabled: true } });
      assert.deepEqual(config, { enabled: true, lineLimit: 4 });
    } finally {
      if (original === undefined) delete process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS;
      else process.env.PI_SUBAGENT_STATUS_MIN_INTERVAL_MS = original;
    }
  });

  it("shared.ts no longer exports throttle/backoff helpers", async () => {
    const shared = await import("../pi-extension/subagents/shared.ts");
    for (const name of [
      "checkStatusThrottle",
      "resetStatusCheckThrottle",
      "getStatusThrottleRemainingMs",
      "getStatusThrottleStrikes",
      "getStatusCheckInterval",
      "setStatusSnapshot",
      "getStatusSnapshot",
    ]) {
      assert.equal(name in shared, false, `${name} should be removed from shared.ts`);
    }
  });

  it("subagent_status returns a live snapshot on every call without throttling", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const statusTool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(statusTool, "expected subagent_status tool to be registered");

    const shared = await import("../pi-extension/subagents/shared.ts");
    const runningMap = shared.runningSubagents;
    runningMap.clear();
    try {
      runningMap.set("a1", {
        id: "a1",
        name: "Worker",
        task: "do work",
        agent: "worker",
        surface: "pane-1",
        startTime: Date.now() - 1000,
        sessionFile: "worker.jsonl",
        interactive: false,
        statusState: createStatusState({ source: "pi", startTimeMs: Date.now() - 1000 }),
      } as any);

      // Repeated calls back-to-back must all return the live snapshot (no throttle/backoff).
      for (let i = 0; i < 5; i++) {
        const result = await statusTool.execute("call", {});
        const details = (result as any).details;
        assert.equal(details.throttled, undefined, `call ${i + 1} should not be throttled`);
        assert.equal(details.agents.length, 1, `call ${i + 1} should report the running agent`);
        assert.equal(details.agents[0].id, "a1");
        assert.match((result as any).content[0].text, /Worker/);
      }
    } finally {
      runningMap.clear();
    }
  });

  it("subagent_status returns empty snapshot immediately when nothing is running", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const statusTool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(statusTool, "expected subagent_status tool to be registered");

    const shared = await import("../pi-extension/subagents/shared.ts");
    shared.runningSubagents.clear();

    for (let i = 0; i < 3; i++) {
      const result = await statusTool.execute("call", {});
      assert.equal((result as any).details.throttled, undefined);
      assert.deepEqual((result as any).details.agents, []);
      assert.equal((result as any).content[0].text, "No running subagents found.");
    }
  });

  it("renderResult renders the empty state (no rate-limit branch)", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const statusTool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(statusTool, "expected subagent_status tool to be registered");

    const theme = {
      fg(_color: string, text: string) { return text; },
      bold(text: string) { return text; },
    };
    const emptyResult = {
      content: [{ type: "text", text: "No running subagents found." }],
      details: { agents: [] },
    };
    const rendered = statusTool.renderResult(emptyResult as any, {}, theme);
    const text = rendered.render(80).join("\n");
    assert.ok(text.includes("No running subagents"), `expected empty-state text, got: ${text}`);
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
      "read,bash,web_search,subagent_done",
    );
  });

  it("buildSubagentToolAllowlist inherits all tools (no allowlist) without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("resolveDenyTools always denies the orchestrator tools", () => {
    const denied = testApi.resolveDenyTools(null);
    for (const tool of ["subagent", "subagent_resume", "subagent_interrupt", "subagent_status", "subagents_list"]) {
      assert.equal(denied.has(tool), true, `expected ${tool} to be denied`);
    }
  });

  it("resolveDenyTools merges frontmatter deny-tools with the orchestrator set", () => {
    const denied = testApi.resolveDenyTools({ denyTools: "claude, web_search" });
    assert.equal(denied.has("claude"), true);
    assert.equal(denied.has("web_search"), true);
    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_status"), true);
  });

  it("buildSubagentToolDenyArgs emits --exclude-tools for the full deny set", () => {
    const denied = testApi.resolveDenyTools({ denyTools: "claude" });
    const args = testApi.buildSubagentToolDenyArgs(denied);
    assert.equal(args[0], "--exclude-tools");
    const tools = args[1].split(",");
    for (const tool of ["subagent", "subagent_resume", "subagent_interrupt", "subagent_status", "subagents_list", "claude"]) {
      assert.ok(tools.includes(tool), `expected ${tool} in exclude list`);
    }
    assert.deepEqual(testApi.buildSubagentToolDenyArgs(new Set()), []);
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

  describe("formatSubagentToolsWidget", () => {
    it("renders the agent tag, active tool count and blocked tools", () => {
      assert.equal(
        formatSubagentToolsWidget("scout", 5, ["bash", "web_search"]),
        "[scout] Active (5 tools) │ Blocked: bash, web_search",
      );
    });

    it("renders `Blocked: none` when nothing is blocked", () => {
      assert.equal(
        formatSubagentToolsWidget("scout", 7, []),
        "[scout] Active (7 tools) │ Blocked: none",
      );
    });

    it("omits the agent tag when no label is known", () => {
      assert.equal(
        formatSubagentToolsWidget("", 3, []),
        "Active (3 tools) │ Blocked: none",
      );
    });

    it("truncates long blocked tool lists so the line never overflows", () => {
      const line = formatSubagentToolsWidget(
        "worker",
        12,
        ["very_long_blocked_tool_name", "another_extremely_long_tool_name", "third_blocked_tool"],
        40,
      );
      assert.ok(visibleWidth(line) <= 40, `expected width <= 40, got ${visibleWidth(line)}`);
      assert.match(line, /…/, `expected ellipsis truncation, got ${JSON.stringify(line)}`);
      assert.ok(
        !line.includes("third_blocked_tool"),
        `expected trailing blocked tool to be cut, got ${JSON.stringify(line)}`,
      );
    });

    it("does not truncate when the line already fits", () => {
      const line = formatSubagentToolsWidget("scout", 2, ["bash"], 120);
      assert.equal(line, "[scout] Active (2 tools) │ Blocked: bash");
    });
  });

  describe("child session widget extension", () => {
    function setupExtension() {
      const widgets: Array<{ key: string; rendered: string[] }> = [];
      const shortcuts: Array<{ key: string; options: any }> = [];
      const handlers: Record<string, Function> = {};

      const theme: any = {
        bg: (_name: string, text: string) => text,
        bold: (text: string) => text,
        fg: (name: string, text: string) => (name === "error" ? `<err>${text}</err>` : text),
      };

      const api: any = {
        on(event: string, handler: Function) {
          handlers[event] = handler;
        },
        registerTool() {},
        registerShortcut(key: string, options: any) {
          shortcuts.push({ key, options });
        },
        getAllTools() {
          return [{ name: "read" }, { name: "bash" }, { name: "web_search" }];
        },
      };

      const ctx: any = {
        ui: {
          setWidget(key: string, factory: any) {
            const component = factory({ width: 200, terminal: { columns: 200 } }, theme);
            const rendered: string[] = component.render ? component.render(200) : [];
            widgets.push({ key, rendered });
          },
        },
        shutdown() {},
      };

      return { api, ctx, widgets, shortcuts, handlers, theme };
    }

    it("does not register the Alt+= toggle shortcut anymore", () => {
      const { api, shortcuts } = setupExtension();
      subagentDoneExtension(api);
      assert.equal(
        shortcuts.find((s) => s.key === "alt+="),
        undefined,
        "Alt+= shortcut must be removed",
      );
    });

    it("renders blocked tools and the active count permanently on session_start", () => {
      const previous = process.env.PI_DENY_TOOLS;
      process.env.PI_DENY_TOOLS = "bash,web_search";
      try {
        const { api, ctx, widgets, handlers } = setupExtension();
        subagentDoneExtension(api);
        handlers["session_start"]?.({}, ctx);

        assert.equal(widgets.length, 1);
        assert.equal(widgets[0].key, "subagent-tools");
        const rendered = widgets[0].rendered.join("\n");
        assert.match(rendered, /Active \(3 tools\)/);
        assert.match(rendered, /Blocked: /);
        assert.match(rendered, /<err>bash<\/err>/);
        assert.match(rendered, /<err>web_search<\/err>/);
      } finally {
        if (previous === undefined) delete process.env.PI_DENY_TOOLS;
        else process.env.PI_DENY_TOOLS = previous;
      }
    });
  });
});

describe("mux.ts interpretExitSidecar", () => {
  const { interpretExitSidecar } = __pollForExitTest__;

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

  it("always denies orchestrator tools regardless of spawning frontmatter", () => {
    const testApi = (subagentsModule as any).__test__;
    const denied = testApi.resolveDenyTools({ spawning: false });

    assert.equal(denied.has("subagent"), true);
    assert.equal(denied.has("subagent_interrupt"), true);
    assert.equal(denied.has("subagent_resume"), true);
    assert.equal(denied.has("subagent_status"), true);
    assert.equal(denied.has("subagents_list"), true);
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
    it("handles whitespace in base and override", () => {
      assert.equal(mergeOverrideList(" read, bash , write ", [" grep ", "edit"]), "read,bash,write,grep,edit");
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

    it("does not suppress skills by default (inherits parent skills)", () => {
      // No explicit skills configured -> subagent inherits the parent Pi
      // environment's skills, so no --no-skills flag is injected.
      const result = buildAgentResourceArgs({ model: "test" }, "/tmp");
      assert.ok(!result.includes("--no-skills"));
    });

    it("does not suppress skills for empty/whitespace-only skills", () => {
      assert.ok(!buildAgentResourceArgs({ skills: "" }, "/tmp").includes("--no-skills"));
      assert.ok(!buildAgentResourceArgs({ skills: "  ,  " }, "/tmp").includes("--no-skills"));
    });

    it("adds --no-extensions and -e for explicit extensions", () => {
      const result = buildAgentResourceArgs(
        { extensions: "/home/user/ext.ts" },
        "/tmp",
      );
      assert.ok(result.includes("--no-extensions"));
      assert.ok(result.includes("-e"));
    });

    it("suppresses default skills and adds --skill for explicit skills", () => {
      // Explicit skills configured -> suppress inherited discovery and load only
      // the explicitly listed skills.
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

// ── Pure Monocle Layout ────────────────────────────────────────────

import {
  resetMonocleLayout,
  createMonocleSurface,
  getMonocleWindow,
} from "../pi-extension/subagents/monocle.ts";

describe("monocle.ts pure fullscreen layout", () => {
  let createWindowCalls: Array<{ windowName: string }> = [];
  let windowPanesReturns: Record<string, string[]> = {};

  function mockCreateWindowFn(windowName: string): string {
    createWindowCalls.push({ windowName });
    return `win-${windowName}-${createWindowCalls.length}`;
  }

  function mockGetWindowPanesFn(windowId: string): string[] {
    return windowPanesReturns[windowId] ?? [];
  }

  beforeEach(() => {
    createWindowCalls = [];
    windowPanesReturns = {};
    resetMonocleLayout();
  });

  it("gives each subagent its own dedicated window with the default pane", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    const result = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(result, "pane-scout-default");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");
  });

  it("does not group same-named subagents — each gets its own window", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    const first = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    windowPanesReturns["win-scout-2"] = ["pane-scout-default-2"];
    const second = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(first, "pane-scout-default");
    assert.equal(second, "pane-scout-default-2");
    assert.equal(createWindowCalls.length, 2);
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");
    assert.equal(getMonocleWindow("pane-scout-default-2"), "win-scout-2");
  });

  it("uses the agent name verbatim (no numeric suffix stripping)", () => {
    windowPanesReturns["win-scout-1-1"] = ["pane-a"];
    createMonocleSurface("scout-1", mockCreateWindowFn, mockGetWindowPanesFn);

    windowPanesReturns["win-planner-2-2"] = ["pane-b"];
    createMonocleSurface("planner-2", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(createWindowCalls[0].windowName, "scout-1");
    assert.equal(createWindowCalls[1].windowName, "planner-2");
  });

  it("resetMonocleLayout clears window tracking", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");

    resetMonocleLayout();
    assert.equal(getMonocleWindow("pane-scout-default"), undefined);
  });

  it("throws when the new window has no default pane", () => {
    windowPanesReturns["win-scout-1"] = [];
    assert.throws(
      () => createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn),
      /No default pane in new window/,
    );
  });
});

describe("prompt-inject", () => {
  it("injects a section containing all three orchestration tool names", async () => {
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
      assert.ok(injected.includes("live snapshot"), "missing live snapshot wording");
      assert.doesNotMatch(injected, /backoff/i, "backoff wording should be removed");
      assert.ok(injected.includes("<!-- subagent-orch-start -->"), "missing start marker");
      assert.ok(injected.includes("<!-- subagent-orch-end -->"), "missing end marker");
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects resume-first convention", async () => {
    const { capturedHandlers, api } = createMockExtensionApi();
    const { registerPromptInject } = await import("../pi-extension/subagents/prompt-inject.ts");

    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSubagentName = process.env.PI_SUBAGENT_NAME;
    const previousHome = process.env.HOME;
    delete process.env.PI_SUBAGENT_NAME;
    const root = mkdtempSync(join(tmpdir(), "pi-test-resume-"));
    const globalDir = join(root, "global");
    const projectDir = join(root, "project");
    const projectAgentsDir = join(projectDir, ".pi", "agents");
    mkdirSync(projectAgentsDir, { recursive: true });
    mkdirSync(globalDir, { recursive: true });
    const homeDir = join(root, "home");
    mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;

    writeAgentFile(projectAgentsDir, "worker", "name: worker");

    process.chdir(projectDir);
    process.env.PI_CODING_AGENT_DIR = globalDir;
    try {
      registerPromptInject(api as any);

      const handler = capturedHandlers["before_agent_start"];
      assert.ok(handler, "before_agent_start handler was registered");

      const result = handler({ systemPrompt: "You are a helpful assistant." }, {});
      const injected = result.systemPrompt;

      assert.ok(injected.includes("### Guidance"), "expected guidance header");
      assert.ok(injected.includes("### Resume-First Convention"), "missing resume-first header");
      assert.ok(injected.includes("subagent_resume"), "missing subagent_resume");
      assert.ok(injected.includes("sessionPath"), "missing sessionPath");
      assert.ok(injected.includes("message: \"<instructions>\"") || injected.includes("message"), "missing message");
      assert.ok(injected.includes("Fresh spawn"), "missing fresh-spawn heading");
      assert.ok(injected.includes("Typical chain"), "missing typical-chain");
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      restoreEnvVar("HOME", previousHome);
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
  it("documents that omitted agent param no longer reduces the tool surface", async () => {
    const { capturedHandlers, api } = createMockExtensionApi();
    const { registerPromptInject } = await import("../pi-extension/subagents/prompt-inject.ts");

    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSubagentName = process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_NAME;
    const root = mkdtempSync(join(tmpdir(), "pi-test-prompt-warn-"));
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
      const result = handler({ systemPrompt: "base prompt" }, {});
      const injected = result.systemPrompt;

      // New model: sub-agents inherit all environment tools by default, so the
      // resume convention must NOT claim that omitting `agent` loses tools.
      assert.ok(
        injected.includes("inherit all environment tools by default"),
        "prompt must state that omitted agent still inherits the full tool surface"
      );
      assert.ok(
        !injected.includes("lose access to most tools"),
        "prompt must not warn about tool loss anymore"
      );
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("subagent_status description", () => {
  it("advertises an immediate live snapshot with no rate limiting", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const tool = registeredTools.find((t: any) => t.name === "subagent_status");
    assert.ok(tool, "expected subagent_status tool");
    assert.match(tool.description, /live snapshot/i);
    assert.match(tool.promptSnippet, /live snapshot/i);
    assert.doesNotMatch(tool.description, /backoff|rate limit/i);
    assert.doesNotMatch(tool.promptSnippet, /backoff|rate limit/i);
  });
});

describe("terminal output cleaning", () => {
  it("removes colors and cursor escape sequences", () => {
    const colored = "\u001b[32mhello\u001b[0m \u001b[1;31mworld\u001b[0m\u001b[2K";
    assert.equal(stripAnsi(colored), "hello world");
  });

  it("normalizes CRLF, trims line ends, collapses empty lines, and trims blanks", () => {
    const raw = "\r\n\r\nline 1   \r\n\r\n\r\n\r\nline 2\t  \r\n\r\n";
    const cleaned = cleanTerminalOutput(raw);
    assert.equal(cleaned, "line 1\n\nline 2");
  });
});

describe("handleSubagentPeek", () => {
  function makeMockRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
    return {
      id: "sub-1",
      name: "Worker",
      task: "build feature",
      surface: "%1",
      startTime: Date.now() - 5000,
      sessionFile: "/tmp/sub-1.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: Date.now() - 5000 }),
      ...overrides,
    } as RunningSubagent;
  }

  it("returns error when target id or name is not found", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const result = handleSubagentPeek({ id: "non-existent" }, runningMap);
    assert.ok(result.details.error);
    assert.match(result.content[0].text, /No running subagent with id "non-existent"/);
  });

  it("successfully peeks running subagent and clamps line count", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const running = makeMockRunning({ id: "sub-peek", name: "Peeker", surface: "%10" });
    runningMap.set(running.id, running);

    let recordedSurface = "";
    let recordedLines = 0;
    const mockPeek = (surface: string, lines?: number) => {
      recordedSurface = surface;
      recordedLines = lines ?? 0;
      return "cleaned output line 1\nline 2";
    };

    // Low clamping: 2 -> 5
    const resLow = handleSubagentPeek({ id: "sub-peek", lines: 2 }, runningMap, mockPeek);
    assert.equal(recordedSurface, "%10");
    assert.equal(recordedLines, 5);
    assert.equal(resLow.details.lines, 5);
    assert.equal(resLow.details.name, "Peeker");
    assert.equal(resLow.content[0].text, "cleaned output line 1\nline 2");

    // High clamping: 500 -> 150
    const resHigh = handleSubagentPeek({ id: "sub-peek", lines: 500 }, runningMap, mockPeek);
    assert.equal(recordedLines, 150);
    assert.equal(resHigh.details.lines, 150);

    // Default: undefined -> 40
    handleSubagentPeek({ id: "sub-peek" }, runningMap, mockPeek);
    assert.equal(recordedLines, 40);
  });

  it("safely catches and formats peek errors if mux throws", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const running = makeMockRunning({ id: "sub-peek", name: "Peeker", surface: "%10" });
    runningMap.set(running.id, running);

    const failingPeek = () => {
      throw new Error("tmux capture failed");
    };
    const result = handleSubagentPeek({ id: "sub-peek" }, runningMap, failingPeek);
    assert.ok(result.details.error);
    assert.match(result.details.error, /tmux capture failed/);
    assert.match(result.content[0].text, /Failed to peek into subagent "Peeker"/);
  });
});

describe("handleSubagentSteer", () => {
  function makeMockRunning(overrides: Partial<RunningSubagent> = {}): RunningSubagent {
    return {
      id: "sub-1",
      name: "Worker",
      task: "build feature",
      surface: "%1",
      startTime: Date.now() - 5000,
      sessionFile: "/tmp/sub-1.jsonl",
      interactive: false,
      statusState: createStatusState({ source: "pi", startTimeMs: Date.now() - 5000 }),
      ...overrides,
    } as RunningSubagent;
  }

  it("rejects empty or whitespace-only message", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const result = handleSubagentSteer({ id: "sub-1", message: "   " }, runningMap, () => {});
    assert.ok(result.details.error);
    assert.match(result.content[0].text, /Provide a non-empty message/);
  });

  it("returns error with subagent_resume hint when target is not running", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const result = handleSubagentSteer({ id: "closed-agent", message: "hello" }, runningMap, () => {});
    assert.ok(result.details.error);
    assert.match(result.content[0].text, /subagent_resume/);
  });

  it("successfully delivers steer text with interrupt: false", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const running = makeMockRunning({ id: "steer-1", name: "Worker", surface: "%20" });
    runningMap.set(running.id, running);

    let deliveredText = "";
    let deliveredOpts: any = null;
    let widgetUpdated = false;

    const mockSteer = (surface: string, text: string, opts?: any) => {
      deliveredText = text;
      deliveredOpts = opts;
    };

    const res = handleSubagentSteer(
      { id: "steer-1", message: "proceed with next task", interrupt: false },
      runningMap,
      () => { widgetUpdated = true; },
      mockSteer,
    );

    assert.equal(deliveredText, "proceed with next task");
    assert.equal(deliveredOpts?.interrupt, false);
    assert.equal(widgetUpdated, false);
    assert.equal(res.details.interrupted, false);
    assert.match(res.content[0].text, /Sent guidance to subagent "Worker"/);
  });

  it("delivers steer text with interrupt: true, triggering status waiting and widget update", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const running = makeMockRunning({ id: "steer-2", name: "Worker", surface: "%20" });
    runningMap.set(running.id, running);

    let deliveredOpts: any = null;
    let widgetUpdated = false;

    const mockSteer = (_surface: string, _text: string, opts?: any) => {
      deliveredOpts = opts;
    };

    const res = handleSubagentSteer(
      { id: "steer-2", message: "stop and rethink", interrupt: true },
      runningMap,
      () => { widgetUpdated = true; },
      mockSteer,
    );

    assert.equal(deliveredOpts?.interrupt, true);
    assert.equal(widgetUpdated, true);
    assert.equal(res.details.interrupted, true);
    assert.match(res.content[0].text, /Interrupted turn and sent guidance to/);
    assert.equal(running.statusState.currentKind, "waiting");
    assert.equal(running.statusState.activityLabel, "interrupted");
  });

  it("safely handles errors if steer throws", () => {
    const runningMap = new Map<string, RunningSubagent>();
    const running = makeMockRunning({ id: "steer-err", name: "Worker", surface: "%20" });
    runningMap.set(running.id, running);

    const failingSteer = () => {
      throw new Error("backend disconnected");
    };

    const res = handleSubagentSteer(
      { id: "steer-err", message: "hello" },
      runningMap,
      () => {},
      failingSteer,
    );

    assert.ok(res.details.error);
    assert.match(res.details.error, /backend disconnected/);
    assert.match(res.content[0].text, /Failed to steer subagent "Worker"/);
  });
});

describe("peek and steer tool registration", () => {
  it("includes subagent_peek and subagent_steer in ORCHESTRATOR_TOOLS", () => {
    assert.ok((ORCHESTRATOR_TOOLS as readonly string[]).includes("subagent_peek"));
    assert.ok((ORCHESTRATOR_TOOLS as readonly string[]).includes("subagent_steer"));
  });

  it("registers subagent_peek and subagent_steer tools with non-throwing renderers", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const peekTool = registeredTools.find((t: any) => t.name === "subagent_peek");
    const steerTool = registeredTools.find((t: any) => t.name === "subagent_steer");

    assert.ok(peekTool, "subagent_peek should be registered");
    assert.ok(steerTool, "subagent_steer should be registered");

    const theme = {
      fg(_color: string, text: string) { return text; },
      bold(text: string) { return text; },
    };

    const peekCall = peekTool.renderCall({ id: "sub-1", lines: 30 }, theme);
    assert.ok(peekCall);
    const steerCall = steerTool.renderCall({ id: "sub-1", message: "do X", interrupt: true }, theme);
    assert.ok(steerCall);

    const peekRes = peekTool.renderResult({ content: [{ text: "terminal text" }], details: { name: "Worker", lines: 30 } }, {}, theme);
    assert.ok(peekRes);
    const steerRes = steerTool.renderResult({ content: [{ text: "steered" }], details: { name: "Worker", interrupted: true } }, {}, theme);
    assert.ok(steerRes);
  });
});

describe("multiplexer prompt injection", () => {
  it("injects multiplexer environment context and tool guidance into system prompt", async () => {
    const { capturedHandlers, api } = createMockExtensionApi();
    const { registerPromptInject } = await import("../pi-extension/subagents/prompt-inject.ts");

    const previousCwd = process.cwd();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousSubagentName = process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_NAME;

    const root = mkdtempSync(join(tmpdir(), "pi-test-prompt-mux-"));
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
      assert.ok(handler, "before_agent_start handler registered");

      const result = handler({ systemPrompt: "base prompt" }, {});
      const injected = result.systemPrompt;

      assert.ok(injected.includes("`subagent_peek`"), "missing subagent_peek");
      assert.ok(injected.includes("`subagent_steer`"), "missing subagent_steer");
      assert.ok(injected.includes("### Multiplexer Environment"), "missing Multiplexer Environment header");
      assert.ok(injected.includes("Pane Layout:"), "missing Pane Layout");
      assert.ok(injected.includes("Live Monitoring & Steering:"), "missing Live Monitoring guidance");
    } finally {
      process.chdir(previousCwd);
      restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
      restoreEnvVar("PI_SUBAGENT_NAME", previousSubagentName);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
