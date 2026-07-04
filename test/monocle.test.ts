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
    return `pane-${name}-${splitCalls.length}`;
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

  // Test 1: First subagent — create window, use default pane directly (no split)
  it("first subagent uses the window's default pane directly (no split)", () => {
    windowPanesReturns["win-scout"] = ["pane-scout-default"];

    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout-default");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(splitCalls.length, 0); // no split for first subagent!
    assert.equal(resizeCalls.length, 0);
  });

  // Test 2: Second subagent same type — split down from last pane, equalize
  it("second subagent same type splits down from last pane and equalizes", () => {
    // First subagent: uses default pane directly
    windowPanesReturns["win-scout"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);

    // Second subagent: split down from default pane
    sizeReturns["pane-scout-default"] = 600;
    windowPanesReturns["win-scout"] = ["pane-scout-default", "pane-scout-1"];

    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout-1");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(splitCalls.length, 1);
    assert.equal(splitCalls[0].direction, "down");
    assert.equal(splitCalls[0].from, "pane-scout-default"); // split from group's only pane
    assert.equal(splitCalls[0].ratio, undefined);
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0].panes, ["pane-scout-default", "pane-scout-1"]);
    assert.equal(resizeCalls[0].targetSize, 300); // (600 + 0) / 2
  });

  // Test 3: Different agent type — separate window with its own default pane
  it("different agent type creates a separate window", () => {
    windowPanesReturns["win-scout"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);

    windowPanesReturns["win-worker"] = ["pane-worker-default"];

    const result = createMonocleSurface(
      "worker",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-worker-default");
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "worker");
    assert.equal(splitCalls.length, 0); // no splits, both got direct default panes
    assert.equal(resizeCalls.length, 0);
  });

  // Test 4: Three instances same type — all in one window, equalize 3 panes
  it("three subagents same type equalizes all panes", () => {
    windowPanesReturns["win-scout"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);

    // Second subagent
    sizeReturns["pane-scout-default"] = 600;
    windowPanesReturns["win-scout"] = ["pane-scout-default", "pane-scout-1"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);

    // Third subagent
    sizeReturns["pane-scout-2"] = 200;
    windowPanesReturns["win-scout"] = ["pane-scout-default", "pane-scout-1", "pane-scout-2"];

    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout-2");
    assert.equal(createWindowCalls.length, 1);
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "down");  // 2nd: split down from default
    assert.equal(splitCalls[0].from, "pane-scout-default");
    assert.equal(splitCalls[1].direction, "down");  // 3rd: split down from scout-1
    assert.equal(splitCalls[1].from, "pane-scout-1");
    assert.equal(resizeCalls.length, 2); // equalize after 2nd and 3rd
    assert.deepEqual(resizeCalls[1].panes, ["pane-scout-default", "pane-scout-1", "pane-scout-2"]);
    assert.equal(resizeCalls[1].targetSize, 266); // (600 + 0 + 200) / 3
  });

  // Test 5: resetMonocleLayout — clears state, fresh start creates new window
  it("resetMonocleLayout clears state and creates fresh windows", () => {
    windowPanesReturns["win-scout"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);
    assert.equal(createWindowCalls.length, 1);

    resetMonocleLayout();

    windowPanesReturns["win-scout"] = ["pane-scout-default-2"];
    const result = createMonocleSurface(
      "scout",
      mockSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout-default-2"); // fresh default pane
    assert.equal(createWindowCalls.length, 2);    // new window after reset
    assert.equal(splitCalls.length, 0);           // no splits either time
    assert.equal(resizeCalls.length, 0);
  });

  // Test 6: Pane closure — catches error, resets group, retries as first agent
  it("pane closure resets group and retries as first agent", () => {
    let callCount = 0;
    const failingSplitFn = (
      name: string,
      direction: "left" | "right" | "up" | "down",
      fromSurface?: string,
      ratio?: number,
    ): string => {
      callCount++;
      if (callCount === 1) throw new Error("pane_not_found"); // fail on first split
      return mockSplitFn(name, direction, fromSurface, ratio);
    };

    // First subagent: succeeds without calling splitFn (uses default pane directly)
    windowPanesReturns["win-scout"] = ["pane-scout-default"];
    createMonocleSurface("scout", mockSplitFn, mockCreateWindowFn, mockGetWindowPanesFn, mockGetSizeFn, mockResizeFn);

    // Second subagent: split fails (callCount=1), retries as first agent
    // Retry creates new window with fresh default pane
    windowPanesReturns["win-scout"] = ["pane-scout-default-2"];
    const result = createMonocleSurface(
      "scout",
      failingSplitFn,
      mockCreateWindowFn,
      mockGetWindowPanesFn,
      mockGetSizeFn,
      mockResizeFn,
    );

    assert.equal(result, "pane-scout-default-2"); // retry returns default pane of new window
    assert.equal(createWindowCalls.length, 2);
    assert.equal(createWindowCalls[0].windowName, "scout");
    assert.equal(createWindowCalls[1].windowName, "scout");
    assert.equal(splitCalls.length, 0); // all splits failed or not called
    assert.equal(resizeCalls.length, 0);
  });

  // Test 7: getGroupName strips numeric suffix
  it("getGroupName strips numeric suffix for grouping", () => {
    assert.equal(getGroupName("scout"), "scout");
    assert.equal(getGroupName("worker"), "worker");
    assert.equal(getGroupName("scout-1"), "scout");
    assert.equal(getGroupName("planner-2"), "planner");
    assert.equal(getGroupName("worker-42"), "worker");
    assert.equal(getGroupName(""), "");
    assert.equal(getGroupName("any-name"), "any-name");
  });

  // Test 8: equalizeMonoclePanes is no-op with <2 panes
  it("equalizeMonoclePanes is no-op with fewer than 2 panes", () => {
    equalizeMonoclePanes(["pane-a"], mockGetSizeFn, mockResizeFn);
    assert.equal(resizeCalls.length, 0);

    equalizeMonoclePanes([], mockGetSizeFn, mockResizeFn);
    assert.equal(resizeCalls.length, 0);
  });
});
