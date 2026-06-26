import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resetLayout,
  createTileSurface,
  DEFAULT_SPLIT_RATIO,
} from "../pi-extension/subagents/mux-layout.ts";

// ── Equalize Stack TDD ─────────────────────────────────────────────

describe("mux-layout.ts equalize stack", () => {
  let splitCalls: Array<{ name: string; direction: string; from?: string; ratio?: number }> = [];
  let resizeCalls: Array<{ panes: string[]; targetHeight: number }> = [];
  let heightReturns: Record<string, number> = {};

  function mockSplitFn(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    ratio?: number,
  ): string {
    splitCalls.push({ name, direction, from: fromSurface, ratio });
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
    const result = createTileSurface(
      "sub-a",
      "tmux",
      mockSplitFn,
      mockResizeFn,
      mockGetHeightFn,
    );
    assert.equal(result, "pane-sub-a");
    assert.equal(splitCalls.length, 1);
    assert.equal(splitCalls[0].direction, "right");
    assert.equal(splitCalls[0].ratio, DEFAULT_SPLIT_RATIO);
    assert.equal(resizeCalls.length, 0);
  });

  // Cycle 2: 2 subagents → equalize 50/50
  it("2 subagents → equalize 50/50 (totalHeight=600, target=300)", () => {
    heightReturns = { "pane-sub-a": 600 };

    createTileSurface("sub-a", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    const result = createTileSurface(
      "sub-b",
      "tmux",
      mockSplitFn,
      mockResizeFn,
      mockGetHeightFn,
    );

    assert.equal(result, "pane-sub-b");
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[1].direction, "down");
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0].panes, ["pane-sub-a", "pane-sub-b"]);
    assert.equal(resizeCalls[0].targetHeight, 300);
  });

  // Cycle 3: 3 subagents → equalize 33/33/33
  it("3 subagents → equalize 33/33/33 (totalHeight=600, target=200)", () => {
    heightReturns = { "pane-sub-a": 600 };

    createTileSurface("sub-a", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    createTileSurface("sub-b", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    const result = createTileSurface(
      "sub-c",
      "tmux",
      mockSplitFn,
      mockResizeFn,
      mockGetHeightFn,
    );

    assert.equal(result, "pane-sub-c");
    assert.equal(resizeCalls.length, 2); // equalize after sub-b AND sub-c
    assert.deepEqual(resizeCalls[1].panes, ["pane-sub-a", "pane-sub-b", "pane-sub-c"]);
    assert.equal(resizeCalls[1].targetHeight, 200); // 600 / 3
  });

  // Cycle 4: pane closure → reset stack, fallback right split
  it("pane closure → resets stack and retries right split", () => {
    heightReturns = { "pane-sub-a": 600 };
    let callCount = 0;
    const failingSplitFn = (
      name: string,
      direction: "left" | "right" | "up" | "down",
      from?: string,
      ratio?: number,
    ): string => {
      callCount++;
      if (callCount === 2) throw new Error("pane_not_found");
      return mockSplitFn(name, direction, from, ratio);
    };

    // sub-a: right split (callCount=1)
    createTileSurface("sub-a", "tmux", failingSplitFn, mockResizeFn, mockGetHeightFn);

    // sub-b: down split from sub-a FAILS (callCount=2), retries right split (callCount=3)
    createTileSurface("sub-b", "tmux", failingSplitFn, mockResizeFn, mockGetHeightFn);

    // splitCalls: [sub-a right, sub-b right (retry)]
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "right");   // sub-a first split
    assert.equal(splitCalls[1].direction, "right");   // sub-b fallback right split

    // Clear resize calls from sub-b's recovery
    resizeCalls = [];
    // Reset heightReturns for new measurement
    heightReturns = { "pane-sub-b": 800 };

    // sub-c: down split from sub-b (stack was reset, now has 2 panes → equalize)
    const result = createTileSurface(
      "sub-c",
      "tmux",
      mockSplitFn,
      mockResizeFn,
      mockGetHeightFn,
    );

    assert.equal(result, "pane-sub-c");
    assert.equal(splitCalls.length, 3);
    assert.equal(splitCalls[2].direction, "down");    // sub-c down from sub-b
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0].panes, ["pane-sub-b", "pane-sub-c"]);
  });

  // Cycle 5: resetLayout → clears stack
  it("resetLayout() → clears stack", () => {
    heightReturns = { "pane-sub-a": 600 };

    createTileSurface("sub-a", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    createTileSurface("sub-b", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);
    assert.equal(resizeCalls.length, 1);  // stack had 2 panes

    resetLayout();

    resizeCalls = [];
    // sub-c starts fresh: right split, no equalize (only 1 pane in stack)
    createTileSurface("sub-c", "tmux", mockSplitFn, mockResizeFn, mockGetHeightFn);

    assert.equal(splitCalls.length, 3);
    assert.equal(splitCalls[2].direction, "right");   // fresh start from main pane
    assert.equal(resizeCalls.length, 0);                // only 1 pane, no equalize
  });
});

// ── Bottom-Stack Layout Tests ─────────────────────────────────────

describe("mux-layout.ts bottom-stack", () => {
  let splitCalls: Array<{ name: string; direction: string; from?: string; ratio?: number }> = [];
  let resizeCalls: Array<{ panes: string[]; targetSize: number }> = [];
  let sizeReturns: Record<string, number> = {};

  function mockSplitFn(
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
    ratio?: number,
  ): string {
    splitCalls.push({ name, direction, from: fromSurface, ratio });
    return `pane-${name}`;
  }

  function mockResizeFn(panes: string[], targetSize: number): void {
    resizeCalls.push({ panes, targetSize });
  }

  function mockGetSizeFn(pane: string): number {
    return sizeReturns[pane] ?? 0;
  }

  beforeEach(() => {
    splitCalls = [];
    resizeCalls = [];
    sizeReturns = {};
    resetLayout();
  });

  it("1 subagent → split down with DEFAULT_SPLIT_RATIO", () => {
    const result = createTileSurface(
      "sub-a",
      "tmux",
      mockSplitFn,
      mockResizeFn,
      mockGetSizeFn,
      "bottom-stack",
    );
    assert.equal(result, "pane-sub-a");
    assert.equal(splitCalls.length, 1);
    assert.equal(splitCalls[0].direction, "down");
    assert.equal(splitCalls[0].ratio, DEFAULT_SPLIT_RATIO);
    assert.equal(resizeCalls.length, 0);
  });

  it("2 subagents → second split is right, equalize widths", () => {
    sizeReturns = { "pane-sub-a": 1000 };

    createTileSurface("sub-a", "tmux", mockSplitFn, mockResizeFn, mockGetSizeFn, "bottom-stack");
    const result = createTileSurface(
      "sub-b", "tmux", mockSplitFn, mockResizeFn, mockGetSizeFn, "bottom-stack",
    );

    assert.equal(result, "pane-sub-b");
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[1].direction, "right");
    assert.equal(resizeCalls.length, 1);
    assert.deepEqual(resizeCalls[0].panes, ["pane-sub-a", "pane-sub-b"]);
    assert.equal(resizeCalls[0].targetSize, 500);
  });

  it("pane closure → fallback down split with ratio", () => {
    sizeReturns = { "pane-sub-a": 1000 };
    let callCount = 0;
    const failingSplitFn = (
      name: string, direction: "left" | "right" | "up" | "down",
      from?: string, ratio?: number,
    ): string => {
      callCount++;
      if (callCount === 2) throw new Error("pane_not_found");
      return mockSplitFn(name, direction, from, ratio);
    };

    createTileSurface("sub-a", "tmux", failingSplitFn, mockResizeFn, mockGetSizeFn, "bottom-stack");
    createTileSurface("sub-b", "tmux", failingSplitFn, mockResizeFn, mockGetSizeFn, "bottom-stack");

    // After pane closure: fallback should be a down split (first direction for bottom-stack)
    assert.equal(splitCalls.length, 2);
    assert.equal(splitCalls[0].direction, "down");    // sub-a first split
    assert.equal(splitCalls[1].direction, "down");    // sub-b fallback down split
  });
});
