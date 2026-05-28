# Plan mode extension

Packaged extension in `extensions/plan-mode/`.

## Commands

- `/plan` - enter plan mode. The UI offers to spawn `plan-agent` immediately.
- `/plan <request>` - enter plan mode and spawn `plan-agent` for the request.
- `/plan spawn <request>` - same as above.
- `/plan status` - show whether plan mode is active.
- `/plan off` - leave plan mode, first showing the latest generated plan when available, then restoring previous active tools and opening the todo sidebar for the latest `.plan/*.jsonl` todo file.
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

## Plan review and exit handoff

After a successful `plan-agent` run, the parent `plan-mode` extension displays the markdown plan content before asking whether to exit plan mode. The review choices are:

- `plan没问题，允许退出plan mode，开始执行` — exit plan mode, open the todo sidebar, and send a kickoff message to execute the approved plan while updating `.plan/todo.jsonl` statuses.
- `允许退出plan mode，先搁置` — exit plan mode and open the todo sidebar without starting execution.
- `不允许退出，需要修改：{修改意见}` — stay in plan mode, collect modification feedback, and ask the main agent to rerun `plan_agent` with the same output path.

When plan mode really exits with an approved/shelved plan, future LLM context is pruned to a hidden handoff containing only the user's original planning prompt, the plan path/content, the todo path, and newer messages. The old planning conversation and `plan_agent` tool history remain in the session file but are not sent as active LLM context.

## Todo sidebar

The todo sidebar reuses the right-side overlay slot used by `/filetree`; opening todo closes/switches away from an active file tree. It renders a V3-style timeline, sizes itself from the current todo content, and watches `.plan/todo.jsonl` (or the latest todo-like `.jsonl` under `.plan/`) for changes.

During `/todo <goal>`, the agent is instructed to update todo statuses as it works:

- `pending` - queued work
- `in_progress` - current work
- `done` - completed work
- `blocked` - cannot proceed; explain the blocker in `description`

`skipped`/`cancelled` are also treated as terminal states by the sidebar.
