/**
 * Agent definition parsing, discovery, and loading.
 */

import { statSync, readdirSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import type { AgentDefaults, AgentDefinition, ListedAgentDefinition, SubagentSessionMode } from "./types.ts";
import { SPAWNING_TOOLS, SUBAGENT_CONTROL_TOOLS } from "./types.ts";
import { getAgentOverride } from "./config.ts";
import { shellEscape } from "./mux.ts";

// ─── Paths ──────────────────────────────────────────────────────

const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

export function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ─── resolveDenyTools ───────────────────────────────────────────

export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      denied.add(t);
    }
  }
  return denied;
}

// ─── Extension Resolvers ────────────────────────────────────────

export function resolveAgentExtensions(raw: string | undefined, agentDir: string): string[] {
  if (!raw) return [];
  const results: string[] = [];
  for (const ref of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (ref.startsWith("npm:") || ref.startsWith("git:")) {
      results.push(ref);
      continue;
    }
    let resolved: string;
    if (ref.startsWith("/")) resolved = ref;
    else if (ref.startsWith("~")) resolved = join(homedir(), ref.slice(1));
    else resolved = join(agentDir, ref);
    try {
      const stat = statSync(resolved);
      if (stat.isDirectory()) {
        results.push(...scanExtensionDir(resolved));
        continue;
      }
    } catch {}
    results.push(resolved);
  }
  return results;
}

function scanExtensionDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts")) results.push(join(dir, entry.name));
      if (entry.isDirectory() && existsSync(join(dir, entry.name, "index.ts"))) results.push(join(dir, entry.name, "index.ts"));
    }
  } catch {}
  return results;
}

function scanSkillDir(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(dir, entry.name, "SKILL.md"))) results.push(join(dir, entry.name));
    }
  } catch {}
  return results;
}

export function buildAgentResourceArgs(agentDefs: AgentDefaults | null, agentDir: string): string[] {
  const args: string[] = [];
  if (!agentDefs) return args;
  const rawExts = agentDefs.extensions;
  if (rawExts !== undefined) {
    args.push("--no-extensions");
    for (const ext of resolveAgentExtensions(rawExts, agentDir)) args.push("-e", shellEscape(ext));
  }
  const rawSkills = agentDefs.skills;
  if (rawSkills !== undefined) {
    args.push("--no-skills");
    for (const skillPath of rawSkills.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (skillPath.includes("/") || skillPath.startsWith("~") || skillPath.startsWith(".")) {
        let resolved: string;
        if (skillPath.startsWith("/")) resolved = skillPath;
        else if (skillPath.startsWith("~")) resolved = join(homedir(), skillPath.slice(1));
        else resolved = join(agentDir, skillPath);
        try {
          const stat = statSync(resolved);
          if (stat.isDirectory()) {
            for (const s of scanSkillDir(resolved)) args.push("--skill", shellEscape(s));
            continue;
          }
        } catch {}
        args.push("--skill", shellEscape(resolved));
      } else {
        args.push("--skill", shellEscape(skillPath));
      }
    }
  }
  return args;
}

// ─── Frontmatter ────────────────────────────────────────────────

export function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

export function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

export function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") return value;
  return undefined;
}

export function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode: systemPromptMode === "replace" ? "replace" : systemPromptMode === "append" ? "append" : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    extensions: getFrontmatterValue(frontmatter, "extension") ?? getFrontmatterValue(frontmatter, "extensions"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    denyTools: getFrontmatterValue(frontmatter, "deny-tools"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    body: body || undefined,
    disableModelInvocation: getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: "package" | "global" | "project" }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];
  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((e) => e.endsWith(".md"))) {
      const parsed = parseAgentDefinition(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (!parsed) continue;
      // Merge overrides from subagent-config.json
      const override = getAgentOverride(process.cwd(), parsed.name);
      if (override) {
        if (override.model) parsed.model = override.model;
        if (override.extensions) parsed.extensions = override.extensions.join(",");
        if (override.skills) parsed.skills = override.skills.join(",");
      }
      agents.set(parsed.name, { ...parsed, source });
    }
  }
  return [...agents.values()];
}

// ─── Path Resolution ────────────────────────────────────────────

export function resolveSubagentPaths(
  params: { cwd?: string },
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd ? (rawCwd.startsWith("/") ? rawCwd : join(cwdBase, rawCwd)) : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir = localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

// ─── Session Resolution ─────────────────────────────────────────

export function resolveEffectiveSessionMode(params: { fork?: boolean }, agentDefs: AgentDefaults | null): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(params: { fork?: boolean }, agentDefs: AgentDefaults | null): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

export function resolveEffectiveInteractive(params: { interactive?: boolean }, agentDefs: AgentDefaults | null): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

// ─── loadAgentDefaults ──────────────────────────────────────────

export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) {
      const override = getAgentOverride(process.cwd(), agentName);
      if (override?.extensions) parsed.extensions = override.extensions.join(",");
      if (override?.skills) parsed.skills = override.skills.join(",");
      if (override?.model) parsed.model = override.model;
      return parsed;
    }
  }
  return null;
}

// ─── Utilities ──────────────────────────────────────────────────

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

export function muxUnavailableResult() {
  return {
    content: [{ type: "text" as const, text: "Subagents require a supported terminal multiplexer. Start pi inside tmux or herdr." }],
    details: { error: "mux not available" },
  };
}

export function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (requested.length === 0) return null;
  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
  return [...allow].join(",");
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);
  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;
  return [...(needsSeparator ? [""] : []), ...skillPrompts, params.taskArg];
}

// ─── Activity Label ─────────────────────────────────────────────

import type { SubagentActivityState } from "./activity.ts";

export function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

export function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}
