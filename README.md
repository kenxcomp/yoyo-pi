# yoyo-pi

<p align="right">
  <a href="README.md"><img src="https://img.shields.io/badge/Language-English-blue" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-brightgreen" alt="简体中文"></a>
</p>

A polished extension pack for [pi](https://pi.dev) that makes the terminal coding-agent workflow faster, cleaner, and more ergonomic.

This is Kenx's daily pi setup, packaged as a reusable GitHub install: Vim-style prompt editing, custom TUI themes and status bars, Grok-style agent-status variants, right-side file/todo overlays, interactive choice pickers, context snapshots, and a read-only planning mode.

## Highlights

- **Vim prompt editing** — toggle `/vim` for normal/insert/visual-style prompt control, with a status pill and external-editor fallback.
- **Custom TUI chrome** — switch themes, full-screen background coverage, and eight status bar/input layouts with `/theme`, `/theme-bg`, and `/switch-statusbar`.
- **Grok-style agent status** — `/switch-agentStatus <1-9|v1-v9>` switches among nine terminal-native thinking/executing/reading/writing readouts with the latest assistant text or latest tool log and current file, while edit/write renderers hide diffs and file contents. Hidden thinking placeholders are suppressed while this UI is enabled.
- **File tree / todo overlays** — open a right-side file picker with `/filetree` or `Ctrl+Shift+F`; monitor `.plan/*.jsonl` todos with `/todo` or `Ctrl+Shift+T`.
- **Agent-friendly choice pickers** — `single_choice`, `multiple_choice`, and `choice_questions` give models structured ways to ask users for decisions.
- **Context snapshots** — `/clear` saves the current branch context, then `/restore <name>` brings it back later.
- **Plan mode** — `/plan` exposes a sandboxed `plan_agent` that writes implementation plans and todos under `.plan/`, previews the plan before exit, and carries forward only the original prompt plus plan context after approval.

## Preview

### Status bar & input variations

<img src="docs/previews/status-bar.png" alt="Status bar and input variation preview" width="760">

Interactive HTML preview: [open the status bar playground](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-status-bar.html?v=9d4f442).

### Agent status variations

<img src="docs/previews/agent-status.svg" alt="Grok-style agent status variation preview" width="760">

Interactive HTML preview: [open the agent status playground](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v1).

Direct jumps: [V1](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v1) · [V2 phase tag](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v2) · [V3](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v3) · [V4](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v4) · [V5](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v5) · [V6](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v6) · [V7](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v7) · [V8](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v8) · [V9](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v9).

### File tree overlay

<img src="docs/previews/filetree.png" alt="File tree overlay preview" width="260">

### Todo timeline sidebar

<img src="docs/previews/todo-sidebar.png" alt="Todo timeline sidebar preview" width="360">

### Choice pickers

<img src="docs/previews/single-choice.png" alt="Single choice picker preview" width="720">

<img src="docs/previews/multiple-choice.png" alt="Multiple choice picker preview" width="720">

## Install

From npm after publishing:

```bash
pi install npm:yoyo-pi
```

Or install directly from GitHub:

```bash
pi install git:git@github.com:kenxcomp/yoyo-pi.git
```

Temporary test without installing:

```bash
pi -e git:git@github.com:kenxcomp/yoyo-pi.git
```

The unpinned Git URL follows `main` when you run `pi update`. Pin a tag only when you want a reproducible release, for example `git:git@github.com:kenxcomp/yoyo-pi.git@v0.1.4`.

After installing this package, remove or move the old local copies under `~/.pi/agent/extensions/` to avoid duplicate slash commands.

## Commands and tools

| Area | Commands / tools | What it adds |
| --- | --- | --- |
| Context snapshots | `/clear`, `/restore <name>` | Save current branch context to `.tmp/<name>.jsonl` and restore it later. |
| Vim prompt mode | `/vim [on\|off\|status]` | Vim-like modal prompt editor with external-editor fallback. |
| Choice pickers | `single_choice`, `multiple_choice`, `choice_questions`, `/choice-demo [multi\|questions]` | Inline-pill single select, compact multi-select, and tabbed batched questions. |
| TUI infrastructure | `/theme <paper\|light\|dark>`, `/theme-bg <true\|false>`, `/filetree`, `Ctrl+Shift+F`, `/switch-statusbar <1-8\|0>` | Themes, optional full-TUI background fill, right-side overlay file picker, and custom statusbar/input UI. Runtime preferences are stored under `~/.pi/agent/state/kenx-infra.json`. |
| Agent status UI | `/switch-agentStatus <1-9\|v1-v9\|0\|off\|status>` | Nine Grok-style status widgets for thinking/executing/reading/writing plus compact built-in tool renderers. V2 uses a meaningful `[agent]` phase tag instead of a fake step count. See the [HTML playground](https://htmlpreview.github.io/?https://github.com/kenxcomp/yoyo-pi/blob/main/docs/previews/pi-tui-agent-status.html?v=gr0k-hack-3#v1) for matching previews. Edit/write show changed file names only; diffs, file contents, and duplicate hidden-thinking placeholders are hidden. Preferences are stored under `~/.pi/agent/state/gr0k-hack.json`. |
| Plan/todo workflow | `/plan`, `/todo <goal>`, `/todo [show\|off\|status]`, `Ctrl+Shift+T`, `plan_agent` | Read-only plan mode delegates planning to `agents/plan-agent.md`; before exiting it displays the plan and asks whether to execute, shelve, or revise. Approved exits prune active LLM context to the original prompt plus plan handoff; todo mode writes/monitors `.plan/todo.jsonl` and asks the agent to keep statuses updated while executing. |

## Development

This package intentionally lists Pi core packages as optional `peerDependencies` because Pi provides them at runtime.

The `pi.extensions` manifest explicitly lists entrypoints so `extensions/plan-mode/sandbox.ts` is not auto-loaded as a normal extension; it is only loaded by the child plan-agent process.
