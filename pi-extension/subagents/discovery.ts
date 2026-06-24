import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export interface ExtensionOption {
  label: string;
  value: string;
  type: "pi-package" | "path";
}

export interface SkillOption {
  label: string;
  value: string;
}

/**
 * Get the directory where bundled agent .md files are located.
 * Resolved relative to the dist directory of this extension.
 */
function getBundledAgentsDir(): string {
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  // ../../agents from pi-extension/subagents/
  return join(moduleDir, "..", "..", "agents");
}

/**
 * Discover agent names by scanning 3 dirs: bundled, global, project.
 * Deduplicates by name (project > global > bundled).
 */
export function discoverAgentNames(
  projectAgentsDir?: string,
): Array<{ name: string; description?: string }> {
  const agentMap = new Map<string, { name: string; description?: string }>();
  const dirs: Array<{ path: string }> = [
    { path: getBundledAgentsDir() },
    { path: join(homedir(), ".pi", "agent", "agents") },
  ];
  if (projectAgentsDir) {
    dirs.push({ path: projectAgentsDir });
  }

  // Process in reverse priority: bundled first, so later dirs override
  for (const { path: dir } of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".md") || !entry.isFile()) continue;
      const content = readFileSync(join(dir, entry.name), "utf-8");
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const name = nameMatch?.[1]?.trim() ?? entry.name.replace(/\.md$/, "");
      const description = descMatch?.[1]?.trim();
      agentMap.set(name, { name, description });
    }
  }

  return Array.from(agentMap.values());
}

/**
 * Discover installed extensions from:
 * 1. ~/.pi/agent/extensions/ directory
 * 2. settings.json packages
 */
export function discoverExtensions(): ExtensionOption[] {
  const discovered: ExtensionOption[] = [];
  const seen = new Set<string>();

  // 1. Scan ~/.pi/agent/extensions/
  const extDir = join(homedir(), ".pi", "agent", "extensions");
  try {
    if (existsSync(extDir)) {
      for (const entry of readdirSync(extDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const extPath = join(extDir, entry.name);
          if (existsSync(join(extPath, "index.ts"))) {
            discovered.push({ label: `📦 ${entry.name} (local)`, value: extPath, type: "path" });
            seen.add(extPath);
          }
        }
      }
    }
  } catch {}

  // 2. Read packages from settings.json
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as { packages?: string[] };
      if (settings.packages && Array.isArray(settings.packages)) {
        for (const pkg of settings.packages) {
          if (!seen.has(pkg)) {
            discovered.push({ label: `📦 ${pkg}`, value: pkg, type: "pi-package" });
            seen.add(pkg);
          }
        }
      }
    }
  } catch {}

  return discovered;
}

/**
 * Discover installed skills from ~/.pi/agent/skills/ directory.
 */
export function discoverSkills(): SkillOption[] {
  const skills: SkillOption[] = [];
  const skillsDir = join(homedir(), ".pi", "agent", "skills");

  try {
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const skillPath = join(skillsDir, entry.name);
          if (existsSync(join(skillPath, "SKILL.md"))) {
            skills.push({ label: `⚡ ${entry.name}`, value: skillPath });
          } else {
            skills.push({ label: `📁 ${entry.name}`, value: skillPath });
          }
        }
      }
    }
  } catch {}

  return skills;
}

/**
 * Format a model for display.
 */
export function formatModelLabel(model: { provider: string; id: string; name?: string }): string {
  const label = `${model.provider}/${model.id}`;
  return model.name ? `${model.name} (${label})` : label;
}

/**
 * Validate model string format (provider/model-id).
 */
export function validateModel(modelStr: string): string | null {
  if (!modelStr.includes("/")) {
    return 'Format model harus "provider/model-id" (contoh: 9r/worker)';
  }
  const parts = modelStr.split("/");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
    return 'Format model tidak valid. Gunakan "provider/model-id"';
  }
  return null;
}

/**
 * Validate extension path format.
 */
export function validatePath(p: string): string | null {
  if (!p.startsWith("/") && !p.startsWith("~") && !p.startsWith("npm:") && !p.startsWith("git:")) {
    return 'Path harus absolute (/path), home (~/path), atau pi package (npm:, git:)';
  }
  if (p.startsWith("/") && !existsSync(p)) {
    return `Path "${p}" tidak ditemukan`;
  }
  if (p.startsWith("~")) {
    const expanded = join(homedir(), p.slice(1));
    if (!existsSync(expanded)) {
      return `Path "${p}" tidak ditemukan`;
    }
  }
  return null;
}
