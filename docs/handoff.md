# Handoff — Monocle Layout Implementation (Selesai)

## Session Context

Implementasi monocle layout untuk pi-my-subagents extension — opsi layout ketiga setelah tiling (default) dan bottom-stack. Dirancang untuk layar kecil (11 inch) di mana tiling/bottom-stack menghasilkan pane terlalu kecil.

**Durasi:** ~2 jam session  
**Backend:** tmux ✅ herdr ✅  
**All commits pushed:** ke `origin/main`

## What Was Built

- **`pi-extension/subagents/monocle.ts`** — layout engine dengan window-per-agent-type grouping
- **`pi-extension/subagents/herdr-mux.ts`** — +2 fungsi: `herdrCreateTab` (return root pane ID), `herdrGetTabPanes` (via `pane layout --pane`)
- **`pi-extension/subagents/tmux-mux.ts`** — +3 fungsi: `tmuxCreateWindow`, `tmuxGetWindowPanes`, `tmuxGetCurrentSession`
- **`test/monocle.test.ts`** — 8 unit test covering all edge cases

### Changes integrasi di file yang ada:
- `types.ts` — `LayoutType` ditambah `'monocle'`
- `mux.ts` — dispatch routing for monocle di `createSurface()`
- `wizard.ts` — opsi monocle di `/subagent-config`
- `config.ts` — validasi layout (`validLayouts`)
- `README.md` — docs 3 layout dengan tabel
- `pi-extension/subagents/AGENTS.md` — update ownership + local contracts

## Monocle Architecture

```
First sub-agent (scout-1):
  → createWindowFn("scout")         → new window/tab
  → getWindowPanesFn(windowId)      → ambil default pane
  → return default pane langsung    (NO split, fullscreen)

Second sub-agent (scout-2):
  → find existing "scout" window
  → splitFn("scout-2", "down", lastPane)
  → equalize all panes in window
  → return new pane ID

Agent type berbeda (worker-1):
  → createWindowFn("worker")        → different window/tab
```

### Key fix (2 iteration):
1. **Bug 1:** First sub-agent melakukan split → mubasir 70% width. Fix: langsung pakai default pane dari window baru.
2. **Bug 2:** First sub-agent split dari `TMUX_PANE` (window utama). Fix: split dari default pane di window monocle.
3. **herdr:** `--name` → `--label`, return `root_pane.pane_id` bukan tab ID. `pane layout --tab` gak ada → ganti `--pane`.

## Current State

- **8 monocle unit test:** ✅ pass
- **Full suite:** 119 tests pass, 0 fail (pre-existing beforeEach issue di `test.ts`, unrelated)
- **Live test (tmux):** 6 sub-agents (2 scout, 2 planner, 2 worker) — grouping by type ✅, equal heights ✅, main window clean ✅
- **Live test (herdr):** dikonfirmasi user jalan normal ✅
- **Git worktrees:** semua sudah dihapus
- **Feature branches:** semua sudah dihapus (local & remote)
- **Cleanup:** `/tmp/*.md` dan `.subagent-output/` sudah dibersihkan

## Known Issues / Loose Ends

| Issue | Severity | Note |
|-------|----------|------|
| Window cleanup after last pane | 🟢 Low | Windows stay open with idle bash after all sub-agents finish. User said "it's ok" — bisa di-add nanti dengan `tryCloseWindowForPane()` di `monocle.ts` |
| `test.ts` beforeEach issue | 🟢 Low | Pre-existing, unrelated to monocle — test setup issue that affects `sendMessage` mock |
| Window naming di tmux | 🟢 Low | Kadang nama window kosong di `display -F '#{window_name}'`. Semantik — tmux internal, not blocking |

## Key Decisions

1. **No keybinding** — user already has their own tmux/herdr navigation preferences
2. **Layout fallback order:** tiling (default) → bottom-stack → monocle — `validLayouts` array in `mux.ts`
3. **`monocle.ts` uses dependency injection** — no direct tmux/herdr imports; all backend calls received as function parameters
4. **Session isolation** — windows/tabs hanya dibuat di session/workspace yang sama (via `HERDR_WORKSPACE_ID` / `tmux display-message`)

## Suggested Skills for Next Session

- **`debug` / `diagnose`** — jika ada bug di runtime herdr/tmux
- **`browser-search`** — jika perlu dokumentasi herdr API atau tmux internal
- **`prototype`** — jika ingin eksplor fitur baru (custom layout, auto-cleanup)
- **`grill-me`** — jika ingin stress-test design untuk fitur tambahan
- **`tdd`** — untuk penambahan fitur dengan test-first approach

## Referenced Artifacts

- PRD: issue `pi-my-subagents-bb7` — problem statement, 10 user stories, implementation decisions
- Commits: `f93ed3f`..`148fa9e` (13 commits total for monocle feature)
- AGENTS.md: `/pi-extension/subagents/AGENTS.md` — ownership contracts
- README.md: Layouts section with 3-row table
