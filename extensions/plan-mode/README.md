# Plan mode extension

Packaged extension in `extensions/plan-mode/`.

## Commands

- `/plan` - enter plan mode. The UI offers to spawn `plan-agent` immediately.
- `/plan <request>` - enter plan mode and spawn `plan-agent` for the request.
- `/plan spawn <request>` - same as above.
- `/plan status` - show whether plan mode is active.
- `/plan off` - leave plan mode, restore previous active tools, and open the todo sidebar for the latest `.plan/*.jsonl` todo file.
- `/todo` - toggle the right-side todo timeline sidebar.
- `/todo show` - open the latest `.plan/*.jsonl` todo sidebar.
- `/todo off` - close the todo sidebar.
- `/todo status` - show the active/latest todo file.
- `/todo <goal>` - ask the main agent to decompose the goal into `.plan/todo.jsonl`, open the sidebar, and execute while updating todo statuses.
- `Ctrl+Shift+T` - toggle the todo sidebar.

## Tool

In plan mode the main agent can use `plan_agent`.

`plan_agent` spawns a separate pi process using the bundled agent at `agents/plan-agent.md` and the sandbox extension at `sandbox.ts`.

The child agent can:

- read/search/list only inside the current repo;
- use read-only bash commands only;
- use `plan_web_search` for external research;
- write/edit under `.plan/` only, including the markdown plan and `.plan/todo.jsonl`;
- delete under `.plan/` only through `plan_delete`.

Plans are written to `.plan/<timestamp>-<slug>.md` unless an output path under `.plan/` is provided.

Each `plan-agent` run must also rewrite `.plan/todo.jsonl` with one JSON object per implementation todo derived from the plan's numbered steps. The todo lines use `type: "plan_todo"`, `schemaVersion: 1`, `planPath`, `step`, `title`, `description`, `status: "pending"`, `priority`, `dependencies`, `validation`, and `createdAt` fields.

## Todo sidebar

The todo sidebar reuses the right-side overlay slot used by `/filetree`; opening todo closes/switches away from an active file tree. It renders a V3-style timeline, sizes itself from the current todo content, and watches `.plan/todo.jsonl` (or the latest todo-like `.jsonl` under `.plan/`) for changes.

During `/todo <goal>`, the agent is instructed to update todo statuses as it works:

- `pending` - queued work
- `in_progress` - current work
- `done` - completed work
- `blocked` - cannot proceed; explain the blocker in `description`

`skipped`/`cancelled` are also treated as terminal states by the sidebar.
