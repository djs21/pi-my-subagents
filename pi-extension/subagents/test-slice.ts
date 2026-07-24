/**
 * Test API surface — re-exports internal functions for test assertions.
 * Provides backward-compatible wrappers that close over module state
 * (runningSubagents, updateWidget) so tests don't need to pass them.
 */

import {
  getShellReadyDelayMs,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveAgentExtensions,
  buildAgentResourceArgs,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveDenyTools,
  resolveResumeLaunchBehavior,
  formatElapsed,
} from "./agent.ts";
import { runningSubagents } from "./shared.ts";
import {
  borderLine,
  renderSubagentWidgetLines,
  resolveResultPresentation,
  updateWidget,
} from "./widget.ts";
import {
  handleSubagentInterrupt as interruptHandleSubagentInterrupt,
  resolveInterruptTarget as interruptResolveInterruptTarget,
  requestSubagentInterrupt,
} from "./interrupt.ts";

// ─── Backward-compatible wrappers ──────────────────────────────

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey?: (surface: string) => void,
  closeSurfaceFn?: (surface: string) => void,
) {
  return interruptHandleSubagentInterrupt(
    params,
    runningSubagents,
    () => updateWidget(null, runningSubagents, false),
    sendEscapeKey ?? (() => {}),
    closeSurfaceFn ?? (() => {}),
  );
}

function resolveInterruptTarget(params: { id?: string; name?: string }) {
  return interruptResolveInterruptTarget(params, runningSubagents);
}

// ─── Test API export ───────────────────────────────────────────

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveAgentExtensions,
  buildAgentResourceArgs,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  resolveDenyTools,
  resolveResumeLaunchBehavior,
  runningSubagents,
  formatElapsed,
  resolveResultPresentation,
  handleSubagentInterrupt,
  resolveInterruptTarget,
  requestSubagentInterrupt,
};
