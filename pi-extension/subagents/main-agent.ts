/**
 * Main-agent guard for delegate mode.
 * - Blocks dangerous tools (write, edit, bash) on the main agent when enabled
 * - Sub-agents are unaffected (env PI_SUBAGENT_NAME is set)
 * - Config persisted at ~/.pi/agent/subagent-config-main.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── Config ────────────────────────────────────────────────────────────

interface MainAgentConfig {
  enabled: boolean;
  blockedTools: string[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "subagent-config-main.json");
const DEFAULT_BLOCKED = ["write", "edit", "bash"];

function loadConfig(): MainAgentConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { enabled: true, blockedTools: [...DEFAULT_BLOCKED] };
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      enabled: parsed.enabled !== false,
      blockedTools: Array.isArray(parsed.blockedTools)
        ? parsed.blockedTools
        : [...DEFAULT_BLOCKED],
    };
  } catch {
    // parse error → silently use defaults
    return { enabled: true, blockedTools: [...DEFAULT_BLOCKED] };
  }
}

function saveConfig(config: MainAgentConfig): boolean {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

// ── Menu / UI helpers ─────────────────────────────────────────────────

function formatBlockedList(tools: string[]): string {
  if (tools.length === 0) return "(none)";
  return tools.join(", ");
}

function buildToolSelectOptions(allTools: string[], blocked: Set<string>): string[] {
  const opts: string[] = [];

  if (blocked.size > 0) {
    opts.push("━ Blocked ─");
    for (const name of allTools) {
      if (blocked.has(name)) opts.push(`✅ ${name}`);
    }
    opts.push("───");
  }

  const allowed = allTools.filter((n) => !blocked.has(n));
  if (allowed.length > 0) {
    opts.push("━ Available — pilih untuk block ─");
    for (const name of allowed) opts.push(`➕ ${name}`);
    opts.push("───");
  }

  opts.push("❌ Done");
  return opts;
}

// ── Guard setup ───────────────────────────────────────────────────────

export function setupMainAgentGuard(pi: ExtensionAPI): void {
  let config = loadConfig();

  // ── tool_call listener ──
  pi.on("tool_call", (event, _ctx) => {
    // Sub-agents have PI_SUBAGENT_NAME set — skip
    if (process.env.PI_SUBAGENT_NAME) return undefined;
    if (!config.enabled) return undefined;
    if (config.blockedTools.includes(event.toolName)) {
      return {
        block: true,
        reason: `[delegate] Tool "${event.toolName}" is blocked on main agent. Use sub-agent instead.`,
      };
    }
    return undefined;
  });

  // ── /delegate slash command ──
  pi.registerCommand("delegate", {
    description: "Configure delegate mode — block dangerous tools on main agent",
    handler: async (_args, ctx) => {
      await showDelegateMenu(pi, ctx, config);
    },
  });
}

async function showDelegateMenu(
  pi: ExtensionAPI,
  ctx: any,
  config: MainAgentConfig,
): Promise<void> {
  let dirty = false;

  const showMenu = async (): Promise<void> => {
    const statusIcon = config.enabled ? "🟢" : "🔴";
    const statusText = config.enabled ? "ACTIVE" : "DISABLED";
    const blockedStr = formatBlockedList(config.blockedTools);

    const title = [
      "┌─ ⚔ Delegate Mode ────────────────────┐",
      `│  Status: ${statusIcon} ${statusText.padEnd(30)}│`,
      `│  Blocked: ${blockedStr.padEnd(31)}│`,
      "│                                       │",
      "│  [1] Toggle delegate mode (on/off)    │",
      "│  [2] Select tools to block            │",
      "│  [3] Reset to defaults                │",
      "│  [4] Save config                      │",
      "└───────────────────────────────────────┘",
    ].join("\n");

    const choice = await ctx.ui.select(title, [
      "1️⃣  Toggle delegate mode (on/off)",
      "2️⃣  Select tools to block",
      "3️⃣  Reset to defaults",
      "4️⃣  Save config",
      "❌ Done",
    ]);

    if (!choice || choice.startsWith("❌")) return;

    if (choice.startsWith("1️⃣")) {
      config.enabled = !config.enabled;
      ctx.ui.notify(
        `Delegate mode ${config.enabled ? "enabled" : "disabled"}`,
        config.enabled ? "info" : "warning",
      );
      dirty = true;
      return showMenu(); // re-render
    }

    if (choice.startsWith("2️⃣")) {
      await showToolSelector(pi, ctx, config);
      dirty = true;
      return showMenu();
    }

    if (choice.startsWith("3️⃣")) {
      config.enabled = true;
      config.blockedTools = [...DEFAULT_BLOCKED];
      ctx.ui.notify("Delegate mode reset to defaults", "info");
      dirty = true;
      return showMenu();
    }

    if (choice.startsWith("4️⃣")) {
      const ok = saveConfig(config);
      ctx.ui.notify(
        ok ? "✅ Config saved" : "❌ Failed to save config",
        ok ? "info" : "error",
      );
      dirty = false;
      return showMenu();
    }
  };

  await showMenu();

  // If unsaved changes, offer to save on exit
  if (dirty) {
    const save = await ctx.ui.confirm(
      "Unsaved changes",
      "Save delegate mode config before exiting?",
    );
    if (save) {
      saveConfig(config);
    }
  }
}

async function showToolSelector(
  pi: ExtensionAPI,
  ctx: any,
  config: MainAgentConfig,
): Promise<void> {
  const allTools = pi
    .getAllTools()
    .map((t) => t.name)
    .sort();
  const blocked = new Set(config.blockedTools);

  while (true) {
    const options = buildToolSelectOptions(allTools, blocked);
    const pick = await ctx.ui.select("Select tools to block (toggle on/off):", options);

    if (!pick || pick === "❌ Done") break;

    // Extract tool name — chop off the ✅ or ➕ prefix
    const clean = pick.replace(/^[✅➕]\s*/, "");
    if (blocked.has(clean)) {
      blocked.delete(clean);
    } else {
      blocked.add(clean);
    }
    // Continue loop — user picks another tool to toggle
  }

  config.blockedTools = Array.from(blocked).sort();
}
