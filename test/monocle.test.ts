import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetMonocleLayout,
  createMonocleSurface,
  equalizeMonoclePanes,
  getGroupName,
  DEFAULT_SPLIT_RATIO,
} from "../pi-extension/subagents/monocle.ts";

describe("monocle.ts", () => {
  let splitCalls: Array<{ name: string; direction: string; from?: string; ratio?: number }> = [];
  let createWindowCalls: Array<{ windowName: string }> = [];
  let resizeCalls: Array<{ panes: string[]; targetSize: number }> = [];
  let sizeReturns: Record<string, number> = {};
  let windowPanesReturns: Record<string, string[]> = {};

  function mockSplitFn(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    ratio?: number,
  ): string {
    splitCalls.push({ name, direction, from: fromSurface, ratio });
    return `pane-${name}`;
  }

  function mockCreateWindowFn(windowName: string): string {
    createWindowCalls.push({ windowName });
    return `win-${windowName}`;
  }

  function mockGetWindowPanesFn(windowId: string): string[] {
    return windowPanesReturns[windowId] ?? [];
  }

  function mockGetSizeFn(pane: string): number {
    return sizeReturns[pane] ?? 0;
  }

  function mockResizeFn(panes: string[], targetSize: number): void {
    resizeCalls.push({ panes, targetSize });
  }

  beforeEach(() => {
    splitCalls = [];
    createWindowCalls = [];
    resizeCalls = [];
    sizeReturns = {};
    windowPanesReturns = {};
    resetMonocleLayout();
  });

  // Test 1: First subagent → calls createWindowFn, splits right once, no equalize
  it("first subagent creates a new window and splits right", () => {
    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(splitCalls.length, 1);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(splitCalls[0].ratio, DEFAULT_SPLIT_RATIO);
    assert.equal(splitCalls[0].from, undefined);
    assert.equal(resizeCalls.length, 0);
  });

  // Test 2: Second subagent same type → no new window, splits down, equalizes 2 panes
  it("second subagent same type splits down and equalizes 2 panes", () => {
    // First subagent
    createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    // Set up size returns so total height = 600
    sizeReturns["pane-scout"] = 600;

    // Set up window panes so the actual window state has both panes
    windowPanesReturns["win-scout"] = ["pane-scout", "pane-scout-2"];

    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout");
    // No new window created (still 1 window)
    assert.equal(createWindowCalls.length, 1);
    assert.equal(splitCalls.length, 2);
    // Second split is down from scout-1
    assert.equal(splitCalls[1].direction, "down");
    assert.equal(splitCalls[1].from, "pane-scout");
    assert.equal(splitCalls[1].ratio, undefined);
    // Equalize was called with the actual panes from getWindowPanesFn
    // totalPanes height = 600 + 0 = 600, target = 300
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0].panes, ["pane-scout", "pane-scout-2"]);
    assert.equal(resizeCalls[0].targetSize, 300);
  });

  // Test 3: Different type → calls createWindowFn, splits right — separate group
  it("different agent type creates a separate window", () => {
    // First agent type: scout
    createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    // Different agent type: worker
    const result = createMonocleSurface(
      "worker",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-worker");
    // Two windows created: one for scout, one for worker
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "worker");
    // Two splits: one per window
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(splitCalls[1].direction, "right");
    // No equalize (only 1 pane per group)
    assert.equal(resizeCalls.length, 0);
  });

  // Test 4: Three instances same type → pane in same window, equalizes 3 panes
  it("three subagents same type equalizes 3 panes", () => {
    // First subagent
    createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    // Second subagent
    sizeReturns["pane-scout"] = 600;
    windowPanesReturns["win-scout"] = ["pane-scout", "pane-scout-2"];

    createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    // Third subagent
    sizeReturns["pane-scout-3"] = 200;
    windowPanesReturns["win-scout"] = ["pane-scout", "pane-scout-2", "pane-scout-3"];

    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout");
    // Only one window for scout group
    assert.equal(createWindowCalls.length, 1);
    assert.equal(splitCalls.length, 3);
    assert.equal(splitCalls[1].direction, "down");
    assert.equal(splitCalls[2].direction, "down");
    // Two equalize calls: one for 2nd, one for 3rd subagent
    assert.equal(resizeCalls.length, 2);
    // Last equalize with 3 panes: total = 600 + 0 + 200 = 800, target = 266
    assert.deepEqual(resizeCalls[1].panes, ["pane-scout", "pane-scout-2", "pane-scout-3"]);
    assert.equal(resizeCalls[1].targetSize, 266);
  });

  // Test 5: resetMonocleLayout() → clears map, fresh start creates new window
  it("resetMonocleLayout clears state and fresh start creates new window", () => {
    // First round
    createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );
    assert.equal(createWindowCalls.length, 1);

    // Reset
    resetMonocleLayout();

    // Fresh start: should create a new window even for same group name
    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout");
    // Two window creations (first round + after reset)
    assert.equal(createWindowCalls.length, 2);
    // Two splits (one per window)
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(splitCalls[1].direction, "right");
    // No equalize (only 1 pane per round)
    assert.equal(resizeCalls.length, 0);
  });

  // Test 6: Pane closure → catches error, resets group, retries as first agent
  it("pane closure → resets group and retries as first agent", () => {
    let callCount = 0;
    const failingSplitFn = (
      name: string,
      direction: "left" | "right" | "up" | "down",
      fromSurface?: string,
      ratio?: number,
    ): string => {
      callCount++;
      // Fail on the second split call (down split for second subagent)
      if (callCount === 2) throw new Error("pane_not_found");
      return mockSplitFn(name, direction, fromSurface, ratio);
    };

    // First subagent succeeds (callCount=1: right split)
    createMonocleSurface(
      "scout",
      failingSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    // Second subagent: down split fails (callCount=2), retries as first agent (callCount=3: right split)
    const result = createMonocleSurface(
      "scout",
      failingSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout");
    // Two windows created: original scout window, then new window after retry
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "scout");
    // Two splits: first for first subagent (right), retry for second subagent (right)
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(splitCalls[0].ratio, DEFAULT_SPLIT_RATIO);
    assert.equal(splitCalls[1].direction, "right");
    assert.equal(splitCalls[1].ratio, DEFAULT_SPLIT_RATIO);
    // No equalize (each window has only 1 pane)
    assert.equal(resizeCalls.length, 0);
  });

  // Test 7: getGroupName returns input unchanged
  it("getGroupName returns the input unchanged", () => {
    assert.equal(getGroupName("scout"), "scout");
    assert.equal(getGroupName("worker"), "worker");
    assert.equal(getGroupName("scout-1"), "scout-1");
    assert.equal(getGroupName(""), "");
    assert.equal(getGroupName("any-name"), "any-name");
  });

  // Test 8: equalizeMonoclePanes is no-op with fewer than 2 panes
  it("equalizeMonoclePanes is no-op with fewer than 2 panes", () => {
    equalizeMonoclePanes(["pane-a"], mockGetSizeFn, mockResizeFn);
    assert.equal(resizeCalls.length, 0);

    equalizeMonoclePanes([], mockGetSizeFn, mockResizeFn);
    assert.equal(resizeCalls.length, 0);
  });
});
