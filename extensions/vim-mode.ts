/**
 * Vim Mode Extension
 *
 * /vim toggles a vim-like modal editor for pi's prompt.
 *
 * - Status pill: "进入vim mode · <normal|insert|visual> mode"
 * - Insert mode: normal pi editor behavior
 * - Normal mode: h/j/k/l, 0/$, w/b, x, i/a, v, / and ! helpers
 * - Visual mode: mode indicator + vim navigation fallback
 * - External editor: Ctrl+G uses $VISUAL/$EDITOR; if unset, auto-falls back to nvim/vim/vi when found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CustomEditor, keyHint, type ExtensionAPI, type ExtensionCommandContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
type VimMode = "normal" | "insert" | "visual";

type ExternalEditorInfo = {
	command?: string;
	autoDetected: boolean;
	setVisual?: boolean;
	previousVisual?: string;
};

const STATUS_KEY = "vim-mode";
const FALLBACK_EDITORS = ["nvim", "vim", "vi"];

const MODE_TEXT: Record<VimMode, string> = {
	normal: "normal mode",
	insert: "insert mode",
	visual: "visual mode",
};

const MODE_COLOR: Record<VimMode, "accent" | "success" | "warning"> = {
	normal: "accent",
	insert: "success",
	visual: "warning",
};

const NORMAL_MOTIONS: Record<string, string> = {
	h: "\x1b[D", // left
	j: "\x1b[B", // down
	k: "\x1b[A", // up
	l: "\x1b[C", // right
	"0": "\x01", // line start (Ctrl+A)
	$: "\x05", // line end (Ctrl+E)
	w: "\x1bf", // word right (Alt+F)
	b: "\x1bb", // word left (Alt+B)
	x: "\x1b[3~", // delete char under cursor
};

function commandExists(command: string): boolean {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(path.delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT?.split(";").filter(Boolean) ?? [".EXE", ".CMD", ".BAT", ""])
			: [""];

	for (const dir of dirs) {
		for (const ext of extensions) {
			const candidate = path.join(dir, command + ext);
			try {
				fs.accessSync(candidate, fs.constants.X_OK);
				return true;
			} catch {
				// Try next PATH entry.
			}
		}
	}

	return false;
}

function describeEditor(command: string | undefined): string | undefined {
	if (!command?.trim()) return undefined;
	const executable = command.trim().split(/\s+/)[0] ?? command.trim();
	return path.basename(executable);
}

function ensureExternalEditor(): ExternalEditorInfo {
	const configured = (process.env.VISUAL || process.env.EDITOR)?.trim();
	if (configured) {
		return { command: configured, autoDetected: false };
	}

	const fallback = FALLBACK_EDITORS.find(commandExists);
	if (fallback) {
		// Pi's built-in external editor action reads $VISUAL first.
		const previousVisual = process.env.VISUAL;
		process.env.VISUAL = fallback;
		return { command: fallback, autoDetected: true, setVisual: true, previousVisual };
	}

	return { autoDetected: false };
}

function restoreExternalEditor(editorInfo: ExternalEditorInfo): void {
	if (!editorInfo.setVisual) return;
	if (editorInfo.previousVisual === undefined) delete process.env.VISUAL;
	else process.env.VISUAL = editorInfo.previousVisual;
}

function isPrintable(data: string): boolean {
	if (!data || data.includes("\x1b")) return false;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return false;
	}
	return true;
}

function setVimStatus(ctx: ExtensionCommandContext, mode: VimMode, editorInfo: ExternalEditorInfo): void {
	const theme = ctx.ui.theme;
	const editorName = describeEditor(editorInfo.command);
	const editorSuffix = editorName
		? theme.fg("dim", ` · ${keyHint("app.editor.external", editorName)}`)
		: theme.fg("dim", " · 内置兜底");

	ctx.ui.setStatus(
		STATUS_KEY,
		`${theme.fg("accent", "进入vim mode")} · ${theme.fg(MODE_COLOR[mode], MODE_TEXT[mode])}${editorSuffix}`,
	);
}

class VimModeEditor extends CustomEditor {
	private mode: VimMode;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly onModeChange: (mode: VimMode) => void,
		initialMode: VimMode = "insert",
	) {
		super(tui, theme, keybindings);
		this.mode = initialMode;
	}

	private setMode(mode: VimMode): void {
		if (this.mode === mode) return;
		this.mode = mode;
		this.onModeChange(mode);
		this.invalidate();
	}

	private runEditorInput(data: string): void {
		super.handleInput(data);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				if (this.isShowingAutocomplete()) {
					this.runEditorInput(data);
				} else {
					this.setMode("normal");
				}
				return;
			}

			if (this.mode === "visual") {
				this.setMode("normal");
				return;
			}

			// In normal mode, keep Pi's app-level Escape behavior (interrupt/abort).
			this.runEditorInput(data);
			return;
		}

		if (this.mode === "insert") {
			this.runEditorInput(data);
			return;
		}

		if (data in NORMAL_MOTIONS) {
			this.runEditorInput(NORMAL_MOTIONS[data]!);
			return;
		}

		if (data === "i") {
			this.setMode("insert");
			return;
		}

		if (data === "a") {
			this.runEditorInput("\x1b[C");
			this.setMode("insert");
			return;
		}

		if (data === "I") {
			this.runEditorInput("\x01");
			this.setMode("insert");
			return;
		}

		if (data === "A") {
			this.runEditorInput("\x05");
			this.setMode("insert");
			return;
		}

		if (data === "v") {
			this.setMode(this.mode === "visual" ? "normal" : "visual");
			return;
		}

		if (this.mode === "visual" && (data === "y" || data === "d")) {
			// The built-in prompt editor does not expose a selection API; keep this as a safe mode exit.
			this.setMode("normal");
			return;
		}

		if (data === "/" || data === "!") {
			// Slash commands and shell prompts are important in pi; make them easy from normal mode.
			this.setMode("insert");
			this.runEditorInput(data);
			return;
		}

		// Let control sequences and app shortcuts through (Ctrl+G external editor, Ctrl+C, Enter, etc.).
		if (!isPrintable(data)) {
			this.runEditorInput(data);
		}
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		const label = ` VIM ${this.mode.toUpperCase()} `;
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= visibleWidth(label) && width > visibleWidth(label)) {
			lines[last] = truncateToWidth(lines[last]!, width - visibleWidth(label), "") + label;
		}

		return lines;
	}
}

export default function vimModeExtension(pi: ExtensionAPI) {
	let enabled = false;
	let mode: VimMode = "insert";
	let previousEditor: EditorFactory | undefined;
	let editorInfo: ExternalEditorInfo = { autoDetected: false };

	function enable(ctx: ExtensionCommandContext): void {
		if (enabled) {
			setVimStatus(ctx, mode, editorInfo);
			ctx.ui.notify("Vim mode 已经启用。再次输入 /vim 可退出。", "info");
			return;
		}

		previousEditor = ctx.ui.getEditorComponent();
		editorInfo = ensureExternalEditor();
		mode = "insert";
		enabled = true;

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new VimModeEditor(
				tui,
				theme,
				keybindings,
				(nextMode) => {
					mode = nextMode;
					setVimStatus(ctx, nextMode, editorInfo);
				},
				mode,
			),
		);
		setVimStatus(ctx, mode, editorInfo);

		const editorName = describeEditor(editorInfo.command);
		const externalHint = editorName
			? `${keyHint("app.editor.external", editorName)}${editorInfo.autoDetected ? "（自动兜底）" : ""}`
			: "未发现 $VISUAL/$EDITOR/nvim/vim/vi，使用内置 vim-like 兜底";
		ctx.ui.notify(`Vim mode enabled: ${externalHint}`, "info");
	}

	function disable(ctx: ExtensionCommandContext): void {
		if (!enabled) {
			ctx.ui.notify("Vim mode 当前未启用。输入 /vim 可进入。", "info");
			return;
		}

		enabled = false;
		mode = "insert";
		restoreExternalEditor(editorInfo);
		editorInfo = { autoDetected: false };
		ctx.ui.setEditorComponent(previousEditor);
		previousEditor = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify("Vim mode disabled", "info");
	}

	pi.registerCommand("vim", {
		description: "Toggle vim mode for the prompt editor",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (["on", "enable", "enter", "start"].includes(action)) {
				enable(ctx);
				return;
			}

			if (["off", "disable", "quit", "exit", "stop"].includes(action)) {
				disable(ctx);
				return;
			}

			if (action === "status") {
				if (enabled) {
					setVimStatus(ctx, mode, editorInfo);
					ctx.ui.notify(`Vim mode: ${MODE_TEXT[mode]}`, "info");
				} else {
					ctx.ui.notify("Vim mode: disabled", "info");
				}
				return;
			}

			if (action && action !== "toggle") {
				ctx.ui.notify("Usage: /vim [on|off|status]", "warning");
				return;
			}

			if (enabled) disable(ctx);
			else enable(ctx);
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (enabled) {
			restoreExternalEditor(editorInfo);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
