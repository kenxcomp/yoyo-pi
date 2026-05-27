# yoyo-pi

Kenx's personal [pi](https://pi.dev) package. It bundles the extensions currently used from `~/.pi/agent/extensions` into one installable package.

## Install

```bash
pi install git:git@github.com:kenxcomp/yoyo-pi.git@v0.1.2
```

Temporary test without installing:

```bash
pi -e git:git@github.com:kenxcomp/yoyo-pi.git@v0.1.2
```

After installing this package, remove or move the old local copies under `~/.pi/agent/extensions/` to avoid duplicate slash commands.

## Included extensions

| Extension | Commands / tools | Notes |
| --- | --- | --- |
| `clear-context.ts` | `/clear`, `/restore <name>` | Save current branch context to `.tmp/<name>.jsonl` and restore it later. |
| `vim-mode.ts` | `/vim [on\|off\|status]` | Vim-like modal prompt editor with external-editor fallback. |
| `kenx-infra` | `/theme <paper\|light\|dark>`, `/theme-bg <true\|false>`, `/filetree`, `Ctrl+Shift+F`, `/switch-statusbar <1-8\|0>` | Themes, optional full-TUI background fill, right-side overlay file picker, and custom statusbar/input UI. Runtime preferences are stored under `~/.pi/agent/state/kenx-infra.json`. |
| `plan-mode` | `/plan`, `plan_agent` | Read-only plan mode that delegates planning to the bundled `agents/plan-agent.md` through `sandbox.ts`. |

## Development

This package intentionally lists Pi core packages as optional `peerDependencies` because Pi provides them at runtime.

The `pi.extensions` manifest explicitly lists entrypoints so `extensions/plan-mode/sandbox.ts` is not auto-loaded as a normal extension; it is only loaded by the child plan-agent process.
