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
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

## Layouts

Sub-agents can be arranged in the multiplexer using one of three layouts:

| Layout | Description |
|--------|-------------|
| **tiling** | Agents split the terminal in a tiled grid — all visible at once. |
| **bottom-stack** | Main agent fills most of the screen; sub-agents stack in a bottom pane. |
| **monocle** | Setiap agent type mendapat window/tab sendiri dalam session/workspace yang sama. Multiple instance dalam tipe yang sama dikelompokkan dalam satu window. Cocok untuk layar kecil — setiap sub-agent mendapat full screen. |

Use **monocle** for small screens where each sub-agent needs full focus, **tiling** when you want a simultaneous overview, and **bottom-stack** when the main session should stay maximised.

## Inter-Agent Communication

Sub-agents can receive messages from the orchestrator while they run, using a file-based inbox.

### How It Works

```
Main agent writes file  →  ~/.local/share/pi/subagents/<id>/incoming/
                          ↓
Sub-agent calls check_messages()  →  reads + deletes file  →  returns content
```

### For the Orchestrator (Main Agent)

Write a file to the sub-agent's `incoming/` directory. The subagent ID is returned when you spawn it.

```bash
echo "your message" > ~/.local/share/pi/subagents/<subagent-id>/incoming/001-instruction.txt
```

### For the Sub-Agent

Call `check_messages()` periodically to see if the orchestrator has sent new instructions or feedback. The tool returns all new messages since your last check — each file is deleted after reading so you never process the same message twice.

### One-Shot Timers (optional)

Install [pi-heartbeat](https://github.com/marcfargas/pi-heartbeat) for periodic wake-ups:

```bash
pi install npm:@marcfargas/pi-heartbeat
```

Then the main agent can use the `heartbeat` tool to wake itself at intervals and check for sub-agent results:

```
heartbeat(action: "start", interval_seconds: 30,
          message: "Check ~/.local/share/pi/subagents/<session_id>/incoming/ for new files")
```

### Direction Summary

| Direction | Mechanism | Tool |
|-----------|-----------|------|
| Main → Sub-agent | File-based inbox | `write` / `bash` |
| Sub-agent → Self | Read inbox | `check_messages()` |
| Sub-agent → Main | Sidecar exit file | `caller_ping()` |
## Bundled Agents

| Agent             | Role                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

## License

MIT
