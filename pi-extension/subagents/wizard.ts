/**
 * Interactive TUI wizards for per-agent config (model, skills).
 * Ported from crew-of-pi config slice. Uses ctx.ui API.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type Component,
  fuzzyFilter,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { discoverAgentNames, discoverSkills, formatModelLabel, validateModel, type SkillOption } from "./discovery.ts";

// ─── Config Category Picker ─────────────────────────────────────

export async function pickConfigCategory(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const choice = await ctx.ui.select("Pilih konfigurasi:", [
    "🤖 Agents — model, skills per agent",
    "📐 Layout — tata letak pane (tiling / bottom-stack / monocle)",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.startsWith("🤖")) return "agents";
  if (choice.startsWith("📐")) return "layout";
  return undefined;
}

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
    "🔧 tools — Atur tools yang aktif",
    "🛠️ skills — Tambah/hapus skills",
    "👀 Lihat konfigurasi saat ini",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.startsWith("🤖")) return "model";
  if (choice.startsWith("🔧")) return "tools";
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

interface ModelOption {
  value: string;
  label: string;
  provider: string;
  id: string;
  searchText: string;
}

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

  // Build options with current model + all available + manual entry
  const options: ModelOption[] = [];

  if (currentModel) {
    const parts = currentModel.split("/");
    options.push({
      value: currentModel,
      label: `🔄 ${currentModel} (current)`,
      provider: parts[0] ?? "",
      id: parts.slice(1).join("/") ?? currentModel,
      searchText: `${currentModel} current`,
    });
  }

  for (const m of allModels) {
    const label = formatModelLabel(m);
    options.push({
      value: `${m.provider}/${m.id}`,
      label,
      provider: m.provider,
      id: m.id,
      searchText: `${m.provider} ${m.id} ${m.name ?? ""} ${label}`,
    });
  }

  // Manual entry always last
  options.push({
    value: "__manual__",
    label: "✏️ Ketik manual...",
    provider: "",
    id: "__manual__",
    searchText: "manual ketik manual",
  });

  // Show custom fuzzy model selector via ctx.ui.custom()
  const result = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const container = new Container();
    let filtered = options;
    let selectedIndex = 0;
    const maxVisible = 12;

    const searchInput = new Input();
    if (currentModel) searchInput.setValue(currentModel);
    searchInput.onSubmit = () => {
      const selected = filtered[selectedIndex];
      if (!selected) return;
      if (selected.value === "__manual__") {
        askManualModel(ctx, currentModel).then(done);
        return;
      }
      done(selected.value);
    };

    // Build UI
    container.addChild(new Box(theme.fg("accent", "━"), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("🔍 Pilih Model (ketik untuk mencari)")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchInput);
    container.addChild(new Spacer(1));

    const listContainer = new Container();
    container.addChild(listContainer);

    container.addChild(new Spacer(1));
    container.addChild(new Text(
      theme.fg("dim", "↑↓ navigate • enter select • esc cancel • ketik untuk fuzzy search"), 0, 0,
    ));
    container.addChild(new Box(theme.fg("accent", "━"), 0, 0));

    function filterModels(query: string): void {
      filtered = query
        ? fuzzyFilter(options, query, (o) => o.searchText)
        : options;
      selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));
      renderList();
    }

    function renderList(): void {
      listContainer.clear();
      if (filtered.length === 0) {
        listContainer.addChild(new Text(theme.fg("muted", "  Tidak ada model yang cocok"), 0, 0));
        return;
      }
      const startIdx = Math.max(0, Math.min(
        selectedIndex - Math.floor(maxVisible / 2),
        filtered.length - maxVisible,
      ));
      const endIdx = Math.min(startIdx + maxVisible, filtered.length);
      for (let i = startIdx; i < endIdx; i++) {
        const item = filtered[i];
        const isSelected = i === selectedIndex;
        const label = isSelected
          ? theme.fg("accent", `→ ${item.label}`)
          : `  ${theme.fg("text", item.label)}`;
        listContainer.addChild(new Text(label, 0, 0));
      }
      if (startIdx > 0 || endIdx < filtered.length) {
        listContainer.addChild(new Text(
          theme.fg("muted", `  (${selectedIndex + 1}/${filtered.length})`),
          0, 0,
        ));
      }
    }

    const component: Component = {
      render(width: number): string[] { return container.render(width); },
      invalidate(): void { container.invalidate(); },
      handleInput(data: string): void {
        const kb = getKeybindings();
        if (kb.matches(data, "tui.select.up")) {
          if (filtered.length === 0) return;
          selectedIndex = selectedIndex === 0 ? filtered.length - 1 : selectedIndex - 1;
          renderList();
          tui.requestRender();
        } else if (kb.matches(data, "tui.select.down")) {
          if (filtered.length === 0) return;
          selectedIndex = selectedIndex === filtered.length - 1 ? 0 : selectedIndex + 1;
          renderList();
          tui.requestRender();
        } else if (kb.matches(data, "tui.select.confirm")) {
          const selected = filtered[selectedIndex];
          if (!selected) return;
          if (selected.value === "__manual__") {
            askManualModel(ctx, currentModel).then(done);
            return;
          }
          done(selected.value);
        } else if (kb.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else {
          searchInput.handleInput(data);
          filterModels(searchInput.getValue());
          tui.requestRender();
        }
      },
    };

    renderList();
    return component;
  });

  if (result === undefined) return undefined;
  return result;
}

async function askManualModel(ctx: ExtensionCommandContext, currentModel?: string): Promise<string | undefined> {
  const manual = await ctx.ui.input("Masukkan model ID (format: provider/model-id):", currentModel || "");
  if (!manual?.trim()) return undefined;
  const err = validateModel(manual.trim());
  if (err) { ctx.ui.notify(`❌ ${err}`, "error"); return undefined; }
  return manual.trim();
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

// ─── Tools Editor ────────────────────────────────────────────────

export async function editTools(
  _agentName: string,
  currentTools: string[] | undefined,
  ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
  const current = currentTools?.join(", ") ?? "";
  const result = await ctx.ui.input(
    `Tools untuk "${_agentName}" (pisahkan dengan koma):`,
    current,
  );
  if (result === undefined || result?.trim() === "") return undefined;
  return result.split(",").map((t) => t.trim()).filter(Boolean);
}

// ─── Shared Helpers ─────────────────────────────────────────────

function resolveToValue(label: string, items: { label: string; value: string }[]): string | undefined {
  const found = items.find((i) => i.label === label);
  if (found) return found.value;
  const customMatch = label.match(/^(.+) \(custom\)$/);
  return customMatch ? customMatch[1] : undefined;
}

// ─── Layout Editor ──────────────────────────────────────────────

export async function editLayout(
  currentLayout: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const choice = await ctx.ui.select("Pilih layout pane:", [
    currentLayout === "tiling" ? "✅ tiling — Master di kiri, sub-agent bertumpuk di kanan (current)" : "⬜ tiling — Master di kiri, sub-agent bertumpuk di kanan",
    currentLayout === "bottom-stack" ? "✅ bottom-stack — Master di atas, sub-agent horizontal di bawah (current)" : "⬜ bottom-stack — Master di atas, sub-agent horizontal di bawah",
    currentLayout === "monocle" ? "✅ monocle — Setiap agent type di window/tab sendiri (current)" : "⬜ monocle — Setiap agent type di window/tab sendiri",
    "❌ Batal",
  ]);
  if (!choice || choice === "❌ Batal") return undefined;
  if (choice.includes("tiling")) return "tiling";
  if (choice.includes("bottom-stack")) return "bottom-stack";
  if (choice.includes("monocle")) return "monocle";
  return undefined;
}

// ─── Shared Helpers ─────────────────────────────────────────────

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