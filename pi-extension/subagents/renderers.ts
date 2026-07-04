/**
 * Message renderers for subagent tool results, status updates, and pings.
 * Pure functions — no module state.
 */

import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { formatElapsed } from "./agent.ts";

interface Theme {
  bg(name: string, text: string): string;
  fg(name: string, text: string): string;
  bold(text: string): string;
}

// ─── subagent_result ───────────────────────────────────────────

export function subagentResultRenderer(message: any, options: any, theme: Theme) {
  const details = message.details as any;
  if (!details) return undefined;

  return {
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const exitCode = details.exitCode ?? 0;
      const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
      const failed = exitCode !== 0 || !!errorMessage;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const bgFn = failed
        ? (text: string) => theme.bg("toolErrorBg", text)
        : (text: string) => theme.bg("toolSuccessBg", text);
      const icon = failed
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
      const status = errorMessage
        ? "failed (provider/agent error)"
        : failed
          ? `failed (exit ${exitCode})`
          : "completed";
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
      const rawContent = typeof message.content === "string" ? message.content : "";

      // Clean summary (remove session ref and leading label for display)
      const summary = rawContent
        .replace(/\n\nSession: .+\nResume: .+$/, "")
        .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
        .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
        .replace(
          new RegExp(
            `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
          ),
          "",
        );

      // Build content for the box
      const contentLines = [header];

      if (options.expanded) {
        // Full view: complete summary + session info
        if (summary) {
          for (const line of summary.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        }
        if (details.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
        }
      } else {
        // Collapsed: preview + expand hint
        if (summary) {
          const previewLines = summary.split("\n").slice(0, 5);
          for (const line of previewLines) {
            contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
          }
          const totalLines = summary.split("\n").length;
          if (totalLines > 5) {
            contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
          }
        }
        contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      // Render via Box for background + padding, with blank line above for separation
      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

// ─── subagent_status ────────────────────────────────────────────

export function subagentStatusRenderer(message: any, options: any, theme: Theme) {
  const details = message.details as any;
  const lines = Array.isArray(details?.lines) ? details.lines : [];
  const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
  if (lines.length === 0 && overflow === 0) return undefined;

  return {
    render(width: number): string[] {
      const lineWidth = Math.max(0, width - 6);
      const contentLines = [
        `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
        ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
      ];

      if (overflow > 0) {
        contentLines.push(theme.fg("muted", `+${overflow} more running.`));
      }
      if (!options.expanded) {
        contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

// ─── subagent_ping ──────────────────────────────────────────────

export function subagentPingRenderer(message: any, options: any, theme: Theme) {
  const details = message.details as any;
  if (!details) return undefined;

  return {
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
      const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

      const icon = theme.fg("accent", "?");
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

      const contentLines = [header];

      if (options.expanded) {
        contentLines.push("");
        contentLines.push(details.message ?? "");
        if (details.sessionFile) {
          contentLines.push("");
          contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
        }
      } else {
        const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
        contentLines.push(theme.fg("dim", preview));
        contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
      }

      const box = new Box(1, 1, bgFn);
      box.addChild(new Text(contentLines.join("\n"), 0, 0));
      return ["", ...box.render(width)];
    },
  };
}

// ─── subagent_stalled ──────────────────────────────────────────

export function subagentStalledRenderer(message: any, _options: any, theme: Theme) {
  const details = message.details as any;
  if (!details) return undefined;

  return {
    render(width: number): string[] {
      const name = details.name ?? "subagent";
      const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
      const elapsed = details.elapsed != null
        ? details.elapsed >= 60
          ? `${Math.floor(details.elapsed / 60)}m ${details.elapsed % 60}s`
          : `${details.elapsed}s`
        : "?";
      const statusLabel = theme.fg("error", "stalled (idle)");
      const text =
        `${theme.fg("error", "!")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${statusLabel} ${theme.fg("dim", `(${elapsed})`)}`;
      const content = typeof message.content === "string" ? message.content : "";
      const lineWidth = Math.max(0, width - 4);
      return ["", text, content ? theme.fg("dim", truncateToWidth(content, lineWidth)) : ""];
    },
  };
}
