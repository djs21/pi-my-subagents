# Issue tracker: Beads (bd)

Issues and PRDs for this repo live as beads in the local [beads](https://github.com/nicedoc/beads) issue database (`.beads/`). Use the `bd` CLI for all operations.

## Conventions

- **Create an issue**: `bd create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `bd show <id>` to view details, `bd comments <id>` for conversation.
- **List issues**: `bd list` with optional `--label` and `--state` filters. Use `bd list --json` for machine-readable output.
- **Comment on an issue**: `bd comment <id> --message "..."`
- **Apply labels**: `bd tag <id> <label>`
- **Remove labels**: `bd update <id> --remove-label <label>`
- **Close**: `bd close <id>`
- **Create parent-child linkage**: `bd link <parent-id> <child-id>`
- **Set priority**: `bd priority <id> P0/P1/P2/P3`

## Issue ID format

Beads uses short hash IDs like `pi-my-subagents-a3f2dd`. Refer to issues by their full ID (e.g., `pi-my-subagents-bvp`).

## When a skill says "publish to the issue tracker"

Create a beads issue using `bd create`.

## When a skill says "fetch the relevant ticket"

Run `bd show <id>` and `bd comments <id>` to read the issue and its conversation thread.
