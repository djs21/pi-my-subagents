# Plan: `/subagent-config` Slash Command

Add interactive slash command to edit per-agent model, extensions, and skills via TUI wizard.

## Vertical Slices

### Slice 1: Config Write-Back

**File:** `pi-extension/subagents/config.ts` (modify)

**Changes:**
1. Export interfaces `AgentResourceOverride`, `SubagentConfig` (currently private)
2. Extract `getConfigPath(scope: "project" | "global", cwd: string): string` from existing hardcoded paths
3. Add `readSubagentConfig(scope, cwd)` — thin public wrapper around existing `loadJsonConfig()`
4. Add `writeSubagentConfig(config, scope, cwd): boolean` — writes JSON to correct path
5. Refactor `loadSubagentConfig()` to use `getConfigPath()` instead of hardcoded paths (same behavior)

**~20 lines added, 0 behavior change for existing consumers**

### Slice 2: Discovery Helpers

**File:** `pi-extension/subagents/discovery.ts` (new)

**Functions:**
1. `discoverAgentNames(ctx?)` — read from `__test__.discoverAgentDefinitions()` if available, else fallback to filesystem scan of 3 dirs (bundled, global, project). Deduplicate by name (project > global > package). Return list of `{ name, description }`.
2. `discoverExtensions()` — scan `~/.pi/agent/extensions/` for dirs with index.ts, read `settings.json` packages, return `ExtensionOption[]`
3. `discoverSkills()` — scan `~/.pi/agent/skills/` for SKILL.md dirs, return `SkillOption[]`
4. `formatModelLabel(model)` — display formatting
5. `validateModel(str)` / `validatePath(str)` — input validation

**Interfaces:** `ExtensionOption { label, value, type }`, `SkillOption { label, value }`

**~120 lines**

### Slice 3: Wizard UI

**File:** `pi-extension/subagents/wizard.ts` (new)

**Functions:**
1. `pickAgent(ctx)` — `ctx.ui.select()` from discovered agent names + "✏️ Ketik nama baru..." + "❌ Batal"
2. `pickField(ctx)` — `ctx.ui.select()` for model/extensions/skills/show
3. `pickScope(ctx)` — `ctx.ui.select()` for "📁 Project" vs "🌐 Global"
4. `editModel(agentName, currentModel, ctx, modelRegistry)` — model picker:
   - Get `modelRegistry.getAvailable()`
   - If empty → fallback to `ctx.ui.input()` for manual entry
   - Show list with fuzzy search via `ctx.ui.custom()` or flat `ctx.ui.select()`
   - Validate with `validateModel()`
5. `editExtensions(agentName, currentExtensions, ctx)` — toggle loop:
   - Show active ✅ / available ➕ / delete 🗑️ / custom path 📂 / done ✅ / cancel ❌
   - Custom path via `ctx.ui.input()`
   - Validate with `validatePath()`
6. `editSkills(agentName, currentSkills, ctx)` — same toggle pattern

**~250 lines**

### Slice 4: Slash Command

**File:** `pi-extension/subagents/commands.ts` (new)

**Functions:**
1. `registerSubagentConfigCommand(pi)` — calls `pi.registerCommand("subagent-config", ...)`
2. `handleSubagentConfigCommand(args, ctx)`:
   - `/subagent-config` → interactive wizard (pick agent → pick field → edit → pick scope → save)
   - `/subagent-config help` → showHelp()
   - `/subagent-config show` → format current config
   - `/subagent-config <agent>` → field picker
   - `/subagent-config <agent> <field>` → direct edit
3. `editFieldForAgent(agentName, field, ctx)` — read config, call wizard editor, ask scope, write config, notify user
4. `showHelp()`, `getArgumentCompletions(prefix)`, `formatCurrentConfig()`, `formatAgentConfig(agentName)`

**Notification after save:** Notify user to run `/reload` for changes to take effect.

**~180 lines**

### Slice 5: Integration Wiring

**File:** `pi-extension/subagents/index.ts` (modify)

**Changes (2 lines):**
1. Add import: `import { registerSubagentConfigCommand } from "./commands.ts";`
2. Add inside default export function (after existing `/plan` registration at line ~2100):
   ```ts
   registerSubagentConfigCommand(pi);
   ```

## Execution Order

```
Slice 1 ──┐
          ├──→ Slice 3 (wizard) ──→ Slice 4 (command) ──→ Slice 5 (wiring)
Slice 2 ──┘
```

Slices 1 & 2 parallel → Slice 3 depends on both → Slice 4 → Slice 5.

## File Summary

| File | Action | Est. Lines |
|------|--------|-----------|
| `config.ts` | Modify (add write, export, extract paths) | +20 |
| `discovery.ts` | New | 120 |
| `wizard.ts` | New | 250 |
| `commands.ts` | New | 180 |
| `index.ts` | Modify (import + register) | +2 |
| **Total** | | **~572** |

## Fixes Applied (from reviewer)

1. ✅ **C1**: config.ts — `readSubagentConfig()` is a thin wrapper, existing `loadSubagentConfig()` unchanged
2. ✅ **C2**: config.ts — `getConfigPath(scope, cwd)` and `writeSubagentConfig(config, scope, cwd)` properly scoped
3. ✅ **C3**: wizard.ts — `editModel()` fallback to manual input when model list empty
4. ✅ **W1**: discovery.ts — tried to import from `__test__` first, fallback to reimplemetation
5. ✅ **W2**: index.ts — registration inside default export after `/plan`
6. ✅ **W3**: Tests — added per-slice in test strategy below
7. ✅ **W4**: commands.ts — notify user to `/reload` after config save

## Test Strategy

| Slice | Test |
|-------|------|
| Slice 1 | `writeSubagentConfig` round-trip: write temp file → read back → assert content |
| Slice 1 | Scope paths: `getConfigPath("project")` returns `.pi/subagent-config.json`, `"global"` returns `~/.pi/agent/subagent-config.json` |
| Slice 2 | `discoverAgentNames()` returns names from bundled agents |
| Slice 2 | `discoverExtensions()` finds extensions in known dirs |
| Slice 2 | `discoverSkills()` finds skills in known dirs |
| Slice 2 | `validateModel()` rejects bad formats |
| Integration | `__test__.writeSubagentConfig` export |
| Integration | `__test__.getConfigPath` export |
