import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetMonocleLayout,
  createMonocleSurface,
  getMonocleWindow,
  DEFAULT_SPLIT_RATIO,
} from "../pi-extension/subagents/monocle.ts";

describe("monocle.ts", () => {
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

  // Test 1: Each subagent gets its own dedicated window, using the default pane
  it("first subagent gets a dedicated window with its default pane", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];

    const result = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(result, "pane-scout-default");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");
  });

  // Test 2: A second subagent with the SAME name gets its OWN new window (no grouping)
  it("second subagent with same name gets its own separate window", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    const first = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    windowPanesReturns["win-scout-2"] = ["pane-scout-default-2"];
    const second = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(first, "pane-scout-default");
    assert.equal(second, "pane-scout-default-2");
    assert.notEqual(first, second);
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "scout");
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");
    assert.equal(getMonocleWindow("pane-scout-default-2"), "win-scout-2");
  });

  // Test 3: Numeric suffixes are NOT stripped — the name is used verbatim
  it("does not strip numeric suffixes from the window name", () => {
    windowPanesReturns["win-scout-1-1"] = ["pane-a"];
    createMonocleSurface("scout-1", mockCreateWindowFn, mockGetWindowPanesFn);

    windowPanesReturns["win-planner-2-2"] = ["pane-b"];
    createMonocleSurface("planner-2", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout-1");
    assert.equal(createWindowCalls[1].windowName, "planner-2");
  });

  // Test 4: Different agent types each get separate windows
  it("different agent types create separate windows", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    const scout = createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);

    windowPanesReturns["win-worker-2"] = ["pane-worker-default"];
    const worker = createMonocleSurface("worker", mockCreateWindowFn, mockGetWindowPanesFn);

    assert.equal(scout, "pane-scout-default");
    assert.equal(worker, "pane-worker-default");
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "worker");
  });

  // Test 5: resetMonocleLayout clears tracking
  it("resetMonocleLayout clears window tracking", () => {
    windowPanesReturns["win-scout-1"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn);
    assert.equal(getMonocleWindow("pane-scout-default"), "win-scout-1");

    resetMonocleLayout();
    assert.equal(getMonocleWindow("pane-scout-default"), undefined);
  });

  // Test 6: Throws when the new window has no default pane
  it("throws when the new window has no default pane", () => {
    windowPanesReturns["win-scout-1"] = [];
    assert.throws(
      () => createMonocleSurface("scout", mockCreateWindowFn, mockGetWindowPanesFn),
      /No default pane in new window/,
    );
  });

  // Test 7: DEFAULT_SPLIT_RATIO stays re-exported for shared consumers
  it("keeps DEFAULT_SPLIT_RATIO re-exported", () => {
    assert.equal(DEFAULT_SPLIT_RATIO, 0.30);
  });
});
