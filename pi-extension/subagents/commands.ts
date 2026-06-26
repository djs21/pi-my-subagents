/**
 * /subagent-config slash command — interactive config wizard for per-agent
 * model, extensions, and skills.
 *
 * Ported from crew-of-pi config.command.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { LayoutType } from "./types.ts";
import { pickAgent, pickField, pickScope, editModel, editExtensions, editSkills, editLayout } from "./wizard.ts";
import { readSubagentConfig, writeSubagentConfig, getConfigPath, type SubagentConfig } from "./config.ts";
import { discoverAgentNames } from "./discovery.ts";

// ─── Top-Level Handler ──────────────────────────────────────────

async function handleSubagentConfigCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const trimmed = args.trim();

  // Show help only when explicitly asked, otherwise start interactive wizard
  if (trimmed === "help" || trimmed === "--help" || trimmed === "-h") {
    ctx.ui.notify(showHelp(), "info");
    return;
  }

  if (trimmed === "show") {
    ctx.ui.notify(formatConfigText(), "info");
    return;
  }

  // Parse optional agent + field
  const parts = trimmed.split(/\s+/);

  // Top-level commands that aren't agent names
  if (parts[0] === "layout") {
    await editTopLevelLayout(ctx);
    return;
  }

  const agentName = parts[0];
  const field = parts[1];

  if (agentName && field) {
    await editFieldForAgent(agentName, field, ctx);
    return;
  }

  if (agentName) {
    const fieldChoice = await pickField(ctx);
    if (!fieldChoice) return;
    if (fieldChoice === "show") {
      ctx.ui.notify(formatAgentConfigText(agentName), "info");
      return;
    }
    await editFieldForAgent(agentName, fieldChoice, ctx);
    return;
  }

  // Interactive wizard: pick agent → pick field → edit → save
  const pickedAgent = await pickAgent(ctx);
  if (!pickedAgent) return;

  const pickedField = await pickField(ctx);
  if (!pickedField) return;

  if (pickedField === "show") {
    ctx.ui.notify(formatAgentConfigText(pickedAgent), "info");
    return;
  }

  if (pickedField === "layout") {
    await editTopLevelLayout(ctx);
    return;
  }

  await editFieldForAgent(pickedAgent, pickedField, ctx);
}

// ─── Per-Agent Edit + Save ──────────────────────────────────────

async function editFieldForAgent(agentName: string, field: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = process.cwd();

  // Read existing config from both scopes, merge to get current values
  const globalConfig = readSubagentConfig("global", cwd);
  const projectConfig = readSubagentConfig("project", cwd);
  const mergedConfig: SubagentConfig = {
    agents: {
      ...(globalConfig?.agents ?? {}),
      ...(projectConfig?.agents ?? {}),
    },
  };
  const currentAgent = mergedConfig.agents?.[agentName];

  if (field === "model") {
    const newModel = await editModel(agentName, currentAgent?.model, ctx);
    if (newModel === undefined) return;
    const scope = await pickScope(ctx);
    if (!scope) return;
    const targetConfig = readSubagentConfig(scope, cwd) ?? { agents: {} };
    if (!targetConfig.agents) targetConfig.agents = {};
    if (!targetConfig.agents[agentName]) targetConfig.agents[agentName] = {};
    targetConfig.agents[agentName].model = newModel;
    if (writeSubagentConfig(targetConfig, scope, cwd)) {
      ctx.ui.notify(`✅ Config untuk "${agentName}" berhasil disimpan!`, "info");
      ctx.ui.notify("ℹ️ Jalankan /reload agar perubahan langsung berlaku", "info");
    }
  } else if (field === "extensions") {
    const newExtensions = await editExtensions(agentName, currentAgent?.extensions, ctx);
    if (newExtensions === undefined) return;
    const scope = await pickScope(ctx);
    if (!scope) return;
    const targetConfig = readSubagentConfig(scope, cwd) ?? { agents: {} };
    if (!targetConfig.agents) targetConfig.agents = {};
    if (!targetConfig.agents[agentName]) targetConfig.agents[agentName] = {};
    targetConfig.agents[agentName].extensions = newExtensions.length > 0 ? newExtensions : undefined;
    if (writeSubagentConfig(targetConfig, scope, cwd)) {
      ctx.ui.notify(`✅ Config untuk "${agentName}" berhasil disimpan!`, "info");
      ctx.ui.notify("ℹ️ Jalankan /reload agar perubahan langsung berlaku", "info");
    }
  } else if (field === "skills") {
    const newSkills = await editSkills(agentName, currentAgent?.skills, ctx);
    if (newSkills === undefined) return;
    const scope = await pickScope(ctx);
    if (!scope) return;
    const targetConfig = readSubagentConfig(scope, cwd) ?? { agents: {} };
    if (!targetConfig.agents) targetConfig.agents = {};
    if (!targetConfig.agents[agentName]) targetConfig.agents[agentName] = {};
    targetConfig.agents[agentName].skills = newSkills.length > 0 ? newSkills : undefined;
    if (writeSubagentConfig(targetConfig, scope, cwd)) {
      ctx.ui.notify(`✅ Config untuk "${agentName}" berhasil disimpan!`, "info");
      ctx.ui.notify("ℹ️ Jalankan /reload agar perubahan langsung berlaku", "info");
    }
  } else if (field === "layout") {
    await editTopLevelLayout(ctx);
  }
}

// ─── Top-Level Layout Editor ───────────────────────────────────

async function editTopLevelLayout(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = process.cwd();
  const globalConfig = readSubagentConfig("global", cwd);
  const projectConfig = readSubagentConfig("project", cwd);
  const currentLayout = projectConfig?.layout ?? globalConfig?.layout;

  const newLayout = await editLayout(currentLayout, ctx);
  if (newLayout === undefined) return;

  const scope = await pickScope(ctx);
  if (!scope) return;

  const targetConfig = readSubagentConfig(scope, cwd) ?? { agents: {} };
  targetConfig.layout = newLayout as LayoutType;
  if (writeSubagentConfig(targetConfig, scope, cwd)) {
    ctx.ui.notify(`✅ Layout "${newLayout}" berhasil disimpan!`, "info");
    ctx.ui.notify("ℹ️ Jalankan /reload agar perubahan langsung berlaku", "info");
  }
}

// ─── Help ───────────────────────────────────────────────────────

function showHelp(): string {
  return [
    "## /subagent-config — Per-Agent Config Manager",
    "",
    "**Usage:**",
    "  `/subagent-config`              — Interactive wizard",
    "  `/subagent-config show`         — Tampilkan semua konfigurasi",
    "  `/subagent-config <agent>`      — Pilih field untuk agent",
    "  `/subagent-config <agent> <field>` — Langsung edit field",
    "",
    "**Fields:** model, extensions, skills, layout",
    "",
    "**Config locations:**",
    "  Project:  .pi/subagent-config.json",
    "  Global:   ~/.pi/agent/subagent-config.json",
  ].join("\n");
}

// ─── Display ────────────────────────────────────────────────────

function formatConfigText(): string {
  const cwd = process.cwd();
  const global = readSubagentConfig("global", cwd);
  const project = readSubagentConfig("project", cwd);
  const lines: string[] = ["## subagent-config.json\n"];

  if (global) {
    lines.push("### Global (~/.pi/agent/)");
    lines.push(formatScopeConfig(global));
  }

  if (project) {
    lines.push("### Project (.pi/)" + (global ? " *(overrides global)*" : ""));
    lines.push(formatScopeConfig(project));
  }

  if (!global && !project) lines.push("Belum ada konfigurasi.");

  return lines.join("\n");
}

function formatScopeConfig(config: SubagentConfig): string {
  const lines: string[] = [];
  if (config.layout) lines.push(`- layout: ${config.layout}`);
  const names = Object.keys(config.agents ?? {});
  if (names.length === 0) {
    lines.push("Belum ada agent dikonfigurasi.");
    return lines.join("\n") + "\n";
  }
  lines.push("");
  for (const name of names) {
    const agent = config.agents[name];
    lines.push(
      [
        `**${name}**`,
        `- model: ${agent.model ?? "(default)"}`,
        `- extensions: ${agent.extensions?.length ? agent.extensions.join(", ") : "(none)"}`,
        `- skills: ${agent.skills?.length ? agent.skills.join(", ") : "(none)"}`,
      ].join("\n"),
    );
  }
  return lines.join("\n") + "\n";
}

function formatAgentConfigText(agentName: string): string {
  const cwd = process.cwd();
  const global = readSubagentConfig("global", cwd);
  const project = readSubagentConfig("project", cwd);

  // Show merged config and which scope contributes
  const lines: string[] = [`Konfigurasi untuk "${agentName}":\n`];

  const globalAgent = global?.agents?.[agentName];
  const projectAgent = project?.agents?.[agentName];

  if (!globalAgent && !projectAgent) {
    lines.push("Belum ada konfigurasi (menggunakan default dari frontmatter .md).");
    return lines.join("\n");
  }

  if (project?.layout) {
    lines.push(`*Layout:* ${project.layout}`);
  } else if (global?.layout) {
    lines.push(`*Layout (global):* ${global.layout}`);
  }

  if (projectAgent) {
    lines.push(`*Project override:*`);
    lines.push(`  model: ${projectAgent.model ?? "-"}`);
    lines.push(`  extensions: ${projectAgent.extensions?.join(", ") ?? "-"}`);
    lines.push(`  skills: ${projectAgent.skills?.join(", ") ?? "-"}`);
  }

  if (globalAgent) {
    const note = projectAgent ? " *(default when no project override)*" : "";
    lines.push(`*Global${note}:*`);
    lines.push(`  model: ${globalAgent.model ?? "-"}`);
    lines.push(`  extensions: ${globalAgent.extensions?.join(", ") ?? "-"}`);
    lines.push(`  skills: ${globalAgent.skills?.join(", ") ?? "-"}`);
  }

  return lines.join("\n");
}

// ─── Argument Completions ───────────────────────────────────────

function getArgumentCompletions(argumentPrefix: string): { value: string; label: string; description?: string }[] | null {
  const prefix = argumentPrefix.toLowerCase();

  if (!prefix || "show".startsWith(prefix) || "help".startsWith(prefix)) {
    return [
      { value: "show", label: "show", description: "Tampilkan semua konfigurasi" },
      { value: "help", label: "help", description: "Tampilkan bantuan" },
    ];
  }

  const firstWord = prefix.split(/\s+/)[0];
  const agentNames = discoverAgentNames().map((a) => a.name);
  const matched = agentNames.filter((n) => n.startsWith(firstWord));

  if (matched.length > 0) {
    return matched.map((n) => ({
      value: n,
      label: n,
      description: `Edit config untuk "${n}"`,
    }));
  }

  return null;
}

// ─── Registration ───────────────────────────────────────────────

export function registerSubagentConfigCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagent-config", {
    description: "Edit per-agent configuration: model, extensions, skills",
    usage: "/subagent-config [agent] [field]",
    handler: handleSubagentConfigCommand,
    getArgumentCompletions,
  } as any);
}