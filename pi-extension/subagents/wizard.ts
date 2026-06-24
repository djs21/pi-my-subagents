/**
 * Interactive TUI wizards for per-agent config (model, extensions, skills).
 * Ported from crew-of-pi config slice. Uses ctx.ui API.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverAgentNames, discoverExtensions, discoverSkills, formatModelLabel, validateModel, validatePath, type ExtensionOption, type SkillOption } from "./discovery.ts";

// ─── Agent Picker ───────────────────────────────────────────────

export async function pickAgent(ctx: ExtensionCommandContext, projectAgentsDir?: string): Promise<string | undefined> {
  const known = discoverAgentNames(projectAgentsDir);
  const options = known.map((a) => `🤖 ${a.name}${a.description ? ` — ${a.description}` : ""}`);
  options.push("✏️ Ketik nama agent baru...", "❌ Batal");

  const choice = await ctx.ui.select("Pilih agent:", options);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice === "✏️ Ketik nama agent baru...") {
    const name = await ctx.ui.input("Nama agent:", "contoh: worker");
    if (!name?.trim()) return undefined;
    return name.trim();
  }
  // Extract name from "🤖 name — description"
  const nameMatch = choice.match(/^🤖 (\S+)/);
  return nameMatch ? nameMatch[1] : undefined;
}

// ─── Field Picker ───────────────────────────────────────────────

export async function pickField(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const choice = await ctx.ui.select("Pilih field yang ingin diedit:", [
    "🤖 model — Pilih model untuk agent ini",
    "🧩 extensions — Tambah/hapus extension",
    "🛠️ skills — Tambah/hapus skills",
    "👀 Lihat konfigurasi saat ini",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.startsWith("🤖")) return "model";
  if (choice.startsWith("🧩")) return "extensions";
  if (choice.startsWith("🛠️")) return "skills";
  if (choice.startsWith("👀")) return "show";
  return undefined;
}

// ─── Scope Picker ───────────────────────────────────────────────

export async function pickScope(ctx: ExtensionCommandContext): Promise<"project" | "global" | undefined> {
  const choice = await ctx.ui.select("Simpan ke mana?", [
    "📁 Project (.pi/subagent-config.json)",
    "🌐 Global (~/.pi/agent/subagent-config.json)",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.startsWith("📁")) return "project";
  return "global";
}

// ─── Model Editor ───────────────────────────────────────────────

export async function editModel(
  _agentName: string,
  currentModel: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const modelRegistry = (ctx as any).modelRegistry;
  let allModels: Array<{ provider: string; id: string; name?: string }> = [];
  try {
    allModels = modelRegistry?.getAvailable() ?? [];
  } catch {}

  if (allModels.length > 0) {
    const modelOptions: string[] = [];
    if (currentModel) {
      modelOptions.push(`🔄 ${currentModel} (current)`);
    }
    for (const m of allModels) {
      modelOptions.push(formatModelLabel(m));
    }
    modelOptions.push("✏️ Ketik manual...", "❌ Batal");

    const choice = await ctx.ui.select(`Pilih model untuk "${_agentName}":`, modelOptions);
    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✏️ Ketik manual...") {
      return askManualModel(ctx, currentModel);
    }
    if (choice.startsWith("🔄 ")) return currentModel;
    const parenMatch = choice.match(/\((\S+\/\S+)\)/);
    if (parenMatch) return parenMatch[1];
    const directMatch = choice.match(/^(\S+\/\S+)/);
    if (directMatch) return directMatch[1];
    return choice;
  }

  return askManualModel(ctx, currentModel);
}

async function askManualModel(ctx: ExtensionCommandContext, currentModel?: string): Promise<string | undefined> {
  const manual = await ctx.ui.input("Masukkan model ID (format: provider/model-id):", currentModel || "");
  if (!manual?.trim()) return undefined;
  const err = validateModel(manual.trim());
  if (err) { ctx.ui.notify(`❌ ${err}`, "error"); return undefined; }
  return manual.trim();
}

// ─── Extensions Editor ──────────────────────────────────────────

export async function editExtensions(
  _agentName: string,
  currentExtensions: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const working = new Set(currentExtensions ?? []);
  const installed = discoverExtensions();

  while (true) {
    const choice = await ctx.ui.select(`Extensions untuk "${_agentName}" (${working.size} aktif):`, buildExtOptions(working, installed));
    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;
    if (choice.startsWith("🗑️ Hapus extension")) {
      const toRemove = await pickRemoveExt(working, installed, ctx);
      if (toRemove) working.delete(toRemove);
      continue;
    }
    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input("Masukkan path extension (absolute / ~/path / npm:... / git:...):", "");
      if (!customPath?.trim()) continue;
      const err = validatePath(customPath.trim());
      if (err) { ctx.ui.notify(`❌ ${err}`, "error"); continue; }
      working.add(customPath.trim());
      continue;
    }
    toggleChoice(choice, working, installed);
  }
  return Array.from(working);
}

function buildExtOptions(working: Set<string>, installed: ExtensionOption[]): string[] {
  const opts: string[] = [];
  if (working.size > 0) {
    opts.push("━ Active ─");
    for (const v of working) {
      const found = installed.find((i) => i.value === v);
      opts.push(found ? `✅ ${found.label}` : `✅ ${v} (custom)`);
    }
    opts.push("───");
  }
  const notAdded = installed.filter((i) => !working.has(i.value));
  if (notAdded.length > 0) {
    opts.push("━ Available — pilih untuk tambah ─");
    for (const ext of notAdded) opts.push(`➕ ${ext.label}`);
    opts.push("───");
  }
  if (working.size > 0) opts.push("🗑️ Hapus extension");
  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan", "❌ Batal");
  return opts;
}

async function pickRemoveExt(working: Set<string>, installed: ExtensionOption[], ctx: ExtensionCommandContext): Promise<string | undefined> {
  const removable = Array.from(working).map((v) => {
    const found = installed.find((i) => i.value === v);
    return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
  });
  removable.push("❌ Batal");
  const toRemove = await ctx.ui.select("Pilih extension yang dihapus:", removable);
  if (!toRemove || toRemove === "❌ Batal") return undefined;
  return resolveToValue(toRemove.replace(/^❌ /, ""), installed);
}

// ─── Skills Editor ──────────────────────────────────────────────

export async function editSkills(
  _agentName: string,
  currentSkills: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const working = new Set(currentSkills ?? []);
  const installed = discoverSkills();

  while (true) {
    const choice = await ctx.ui.select(`Skills untuk "${_agentName}" (${working.size} aktif):`, buildSkillOptions(working, installed));
    if (!choice || choice === "❌ Batal") return undefined;
    if (choice === "✅ Selesai — simpan perubahan") break;
    if (choice.startsWith("🗑️ Hapus skill")) {
      const toRemove = await pickRemoveSkill(working, installed, ctx);
      if (toRemove) working.delete(toRemove);
      continue;
    }
    if (choice === "📂 Tambah path/folder kustom") {
      const customPath = await ctx.ui.input("Masukkan path folder skill (absolute atau ~/path):", "");
      if (!customPath?.trim()) continue;
      working.add(customPath.trim());
      continue;
    }
    toggleChoice(choice, working, installed);
  }
  return Array.from(working);
}

function buildSkillOptions(working: Set<string>, installed: SkillOption[]): string[] {
  const opts: string[] = [];
  if (working.size > 0) {
    opts.push("━ Active ─");
    for (const v of working) {
      const found = installed.find((i) => i.value === v);
      opts.push(found ? `✅ ${found.label}` : `✅ ${v} (custom)`);
    }
    opts.push("───");
  }
  const notAdded = installed.filter((i) => !working.has(i.value));
  if (notAdded.length > 0) {
    opts.push("━ Available — pilih untuk tambah ─");
    for (const skill of notAdded) opts.push(`➕ ${skill.label}`);
    opts.push("───");
  }
  if (working.size > 0) opts.push("🗑️ Hapus skill");
  opts.push("📂 Tambah path/folder kustom");
  opts.push("✅ Selesai — simpan perubahan", "❌ Batal");
  return opts;
}

async function pickRemoveSkill(working: Set<string>, installed: SkillOption[], ctx: ExtensionCommandContext): Promise<string | undefined> {
  const removable = Array.from(working).map((v) => {
    const found = installed.find((i) => i.value === v);
    return found ? `❌ ${found.label}` : `❌ ${v} (custom)`;
  });
  removable.push("❌ Batal");
  const toRemove = await ctx.ui.select("Pilih skill yang dihapus:", removable);
  if (!toRemove || toRemove === "❌ Batal") return undefined;
  return resolveToValue(toRemove.replace(/^❌ /, ""), installed);
}

// ─── Shared Helpers ─────────────────────────────────────────────

function resolveToValue(label: string, items: { label: string; value: string }[]): string | undefined {
  const found = items.find((i) => i.label === label);
  if (found) return found.value;
  const customMatch = label.match(/^(.+) \(custom\)$/);
  return customMatch ? customMatch[1] : undefined;
}

function toggleChoice(choice: string, working: Set<string>, items: { label: string; value: string }[]): void {
  const prefix = choice.startsWith("➕ ") ? "➕ " : "✅ ";
  const label = choice.replace(prefix, "");
  const found = items.find((i) => i.label === label);
  if (found) {
    if (working.has(found.value)) working.delete(found.value);
    else working.add(found.value);
  } else {
    const customMatch = label.match(/^(.+) \(custom\)$/);
    if (customMatch) {
      if (working.has(customMatch[1])) working.delete(customMatch[1]);
      else working.add(customMatch[1]);
    }
  }
}