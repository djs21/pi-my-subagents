# pi-my-subagent

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, or `stalled`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

For parallel execution, just call `subagent` multiple times — they all run concurrently.

## Install

```bash
pi install git:github.com/<your-username>/pi-my-subagent
```

Supported multiplexers:

- [tmux](https://github.com/tmux/tmux)
- [herdr](https://herdr.dev) (terminal-native agent multiplexer)

Start pi inside one of them:

```bash
tmux new -A -s pi 'pi'
# or just run pi inside herdr — herdr is detected automatically
```

Optional: set `PI_SUBAGENT_MUX=tmux|herdr` to force a specific backend.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [tmux](https://github.com/tmux/tmux)
  - [herdr](https://herdr.dev)

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes.

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Worker", agent: "worker", task: "Investigate and fix..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```


## Layouts

Sub-agents can be arranged in the multiplexer using one of three layouts:

| Layout | Description |
|--------|-------------|
| **tiling** | Agents split the terminal in a tiled grid — all visible at once. |
| **bottom-stack** | Main agent fills most of the screen; sub-agents stack in a bottom pane. |
| **monocle** | Setiap sub-agent mendapat window/tab fullscreen sendiri di session/workspace yang sama — tanpa pengelompokan nama atau sub-split. Cocok untuk layar kecil — setiap sub-agent mendapat ruang pandang maksimal. |

Use **monocle** for small screens where each sub-agent needs full focus, **tiling** when you want a simultaneous overview, and **bottom-stack** when the main session should stay maximised.

## Inter-Agent Communication

Sub-agents notify the orchestrator when they need help by exiting with a sidecar file that carries their request.

### How It Works

```
Sub-agent calls caller_ping()  →  writes sidecar exit file  →  exits
                               ↓
Orchestrator sees the ping    →  resumes the session with a response
```

### For the Sub-Agent

When stuck, in need of clarification, or when the parent must take action, call `caller_ping(message)`. The session exits and the orchestrator is notified with your message.

### For the Orchestrator (Main Agent)

A `subagent_result` steer message with the ping payload arrives automatically. Resume the sub-agent's session with `subagent_resume` to answer.

### Direction Summary

| Direction | Mechanism | Tool |
|-----------|-----------|------|
| Sub-agent → Main | Sidecar exit file | `caller_ping()` |

## Configuration — `subagent-config.json`

The extension is configured with a JSON file. Configuration is optional — without a file, every agent uses the defaults from its `.md` frontmatter.

### File Locations

| Scope | Path | Purpose |
|-------|------|---------|
| **Project** | `<project>/.pi/subagent-config.json` | Overrides tuned for this repository. Committed with the project. |
| **Global** | `~/.pi/agent/subagent-config.json` | Your personal defaults, applied across all projects. |

A ready-to-copy example lives at [`.pi/subagent-config.json.example`](.pi/subagent-config.json.example).

```bash
cp .pi/subagent-config.json.example .pi/subagent-config.json
```

### Evaluation Hierarchy

Each supported property is resolved from highest to lowest priority:

```
Tool arguments (subagent tool call)
        >
Project config  (.pi/subagent-config.json)
        >
Global config   (~/.pi/agent/subagent-config.json)
        >
Frontmatter     (agent .md definition)
```

- **Tool arguments** win for that single invocation only — pass `model`, `tools`, etc. directly on the `subagent(...)` call.
- **Project config** wins over global config for the same field; global fills the gaps.
- **Frontmatter** is the base agent definition (`.pi/agents/*.md` or bundled agents).
- `model` **replaces** the lower-priority value; `tools`, `skills`, and `extensions` are **appended** to the base list and de-duplicated (they never remove base entries).

### Properties

Top level:

| Property | Type | Description |
|----------|------|-------------|
| `layout` | `"tiling"` \| `"bottom-stack"` \| `"monocle"` | Pane arrangement for sub-agents. Project overrides global. |
| `agents` | object | Per-agent overrides keyed by agent name. |

Each entry under `agents.<name>`:

| Property | Type | Merge | Description |
|----------|------|-------|-------------|
| `model` | string | replace | Model in `provider/model-id` form. |
| `tools` | string[] | append | Extra tools to add to the agent's base tools. |
| `skills` | string[] | append | Extra skills to add to the agent's base skills. |
| `extensions` | string[] | append | Extension references — paths (`/abs/path`, `~/path`) or pi packages (`npm:...`, `git:...`). |

### Example

```json
{
  "layout": "bottom-stack",
  "agents": {
    "worker": {
      "model": "anthropic/claude-sonnet-4-6",
      "tools": ["bash", "web_search"],
      "skills": ["tdd"],
      "extensions": ["git:github.com/your-org/your-extension"]
    },
    "reviewer": {
      "model": "anthropic/claude-opus-4-1",
      "tools": [],
      "skills": [],
      "extensions": []
    }
  }
}
```

Only the properties you set are overridden; everything else keeps its default. Changes take effect on the next subagent spawn — run `/reload` if you edited the file during a running session.

## Bundled Agents

| Agent        | Role                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| **worker**   | Implements tasks from todos — writes code, runs tests, makes polished commits |
| **reviewer** | Reviews code for bugs, security issues, correctness                           |

## License

MIT
