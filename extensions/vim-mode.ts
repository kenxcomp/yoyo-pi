/**
 * Vim Mode Extension
 *
 * /vim toggles a vim-like modal editor for pi's prompt.
 *
 * - Status pill: "VIM <NORMAL|INSERT|VISUAL>" via the active footer/statusbar
 * - Insert mode: normal pi editor behavior
 * - Normal mode: h/j/k/l, 0/$, w/b, x, i/a, v, / and ! helpers
 * - Visual mode: mode indicator + vim navigation fallback
 * - External editor: Ctrl+G uses $VISUAL/$EDITOR; if unset, auto-falls back to nvim/vim/vi when found.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	CustomEditor,
	keyHint,
	type AppKeybinding,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
type VimMode = "normal" | "insert" | "visual";
type VimStatusContext = { ui: { setStatus(key: string, text: string | undefined): void } };
type VimModeBridge = {
	isEnabled(): boolean;
	getMode(): VimMode;
	refreshStatus(ctx: VimStatusContext): void;
	wrapEditorFactory(baseFactory: EditorFactory | undefined, ctx: VimStatusContext): EditorFactory;
};
type KenxStatusbarBridge = {
	isEnabled(): boolean;
	getEditorFactory(): EditorFactory | undefined;
	setStatus?(key: string, text: string | undefined): void;
};

type ExternalEditorInfo = {
	command?: string;
	autoDetected: boolean;
	setVisual?: boolean;
	previousVisual?: string;
};

const STATUS_KEY = "vim-mode";
const VIM_BRIDGE_KEY = Symbol.for("yoyo-pi.vim-mode.bridge");
const KENX_STATUSBAR_BRIDGE_KEY = Symbol.for("yoyo-pi.kenx-statusbar.bridge");
const FALLBACK_EDITORS = ["nvim", "vim", "vi"];

const MODE_TEXT: Record<VimMode, string> = {
	normal: "normal mode",
	insert: "insert mode",
	visual: "visual mode",
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

function getKenxStatusbarBridge(): KenxStatusbarBridge | undefined {
	return (globalThis as Record<symbol, KenxStatusbarBridge | undefined>)[KENX_STATUSBAR_BRIDGE_KEY];
}

function setVimStatus(ctx: VimStatusContext, mode: VimMode): void {
	const text = `VIM ${mode.toUpperCase()}`;
	ctx.ui.setStatus(STATUS_KEY, text);
	getKenxStatusbarBridge()?.setStatus?.(STATUS_KEY, text);
}

function clearVimStatus(ctx: VimStatusContext): void {
	ctx.ui.setStatus(STATUS_KEY, undefined);
	getKenxStatusbarBridge()?.setStatus?.(STATUS_KEY, undefined);
}

function getKenxStatusbarEditorFactory(): EditorFactory | undefined {
	const bridge = getKenxStatusbarBridge();
	return bridge?.isEnabled() ? bridge.getEditorFactory() : undefined;
}

class VimModeEditor implements EditorComponent {
	public actionHandlers = new Map<AppKeybinding, () => void>();
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onExtensionShortcut?: (data: string) => boolean;

	private mode: VimMode;
	private pendingOperator: "d" | undefined;
	private _focused = false;

	constructor(
		private readonly base: EditorComponent,
		private readonly keybindings: KeybindingsManager,
		private readonly onModeChange: (mode: VimMode) => void,
		initialMode: VimMode = "insert",
	) {
		this.mode = initialMode;
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		const focusable = this.base as EditorComponent & { focused?: boolean };
		if ("focused" in focusable) focusable.focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}

	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}

	get borderColor(): EditorComponent["borderColor"] {
		return this.base.borderColor;
	}

	set borderColor(value: EditorComponent["borderColor"]) {
		this.base.borderColor = value;
	}

	private setMode(mode: VimMode): void {
		if (this.mode === mode) return;
		this.pendingOperator = undefined;
		this.mode = mode;
		this.onModeChange(mode);
		this.invalidate();
	}

	private runEditorInput(data: string): void {
		this.pendingOperator = undefined;
		this.base.handleInput(data);
	}

	private deleteCurrentLine(): void {
		this.pendingOperator = undefined;

		const editor = this.base as EditorComponent & {
			getLines?: () => string[];
			getCursor?: () => { line: number; col: number };
		};
		const lines = editor.getLines?.() ?? this.base.getText().split("\n");
		const cursor = editor.getCursor?.() ?? { line: Math.max(0, lines.length - 1), col: 0 };
		const lineToDelete = Math.max(0, Math.min(cursor.line, Math.max(0, lines.length - 1)));

		if (lines.length <= 1) {
			this.base.setText("");
			return;
		}

		const nextLines = [...lines];
		nextLines.splice(lineToDelete, 1);
		this.base.setText(nextLines.join("\n"));

		// EditorComponent does not expose cursor mutation, but pi's built-in Editor keeps
		// runtime state on a normal property. Restore vim-like cursor position when possible.
		const runtime = this.base as unknown as {
			state?: { cursorLine: number; cursorCol: number };
			tui?: { requestRender(): void };
		};
		if (runtime.state) {
			const nextLine = Math.max(0, Math.min(lineToDelete, nextLines.length - 1));
			runtime.state.cursorLine = nextLine;
			runtime.state.cursorCol = Math.max(0, Math.min(cursor.col, nextLines[nextLine]?.length ?? 0));
			runtime.tui?.requestRender();
		}
	}

	private isShowingAutocomplete(): boolean {
		const editor = this.base as EditorComponent & { isShowingAutocomplete?: () => boolean };
		return editor.isShowingAutocomplete?.() ?? false;
	}

	private handleAppInput(data: string): boolean {
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}

		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return true;
				}
			}
			this.runEditorInput(data);
			return true;
		}

		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return true;
			}
			return false;
		}

		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return true;
			}
		}

		return false;
	}

	handleInput(data: string): void {
		if (this.onExtensionShortcut?.(data)) return;

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
			if (!this.handleAppInput(data)) this.runEditorInput(data);
			return;
		}

		if (this.handleAppInput(data)) return;

		if (data === "dd" && this.mode !== "insert") {
			this.deleteCurrentLine();
			return;
		}

		if (this.mode === "insert") {
			this.runEditorInput(data);
			return;
		}

		if (this.mode === "normal" && this.pendingOperator === "d") {
			if (data === "d") {
				this.deleteCurrentLine();
				return;
			}
			this.pendingOperator = undefined;
		}

		if (this.mode === "normal" && data === "d") {
			this.pendingOperator = "d";
			this.invalidate();
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
		return this.base.render(width);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	dispose(): void {
		(this.base as EditorComponent & { dispose?: () => void }).dispose?.();
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}
}

export default function vimModeExtension(pi: ExtensionAPI) {
	let enabled = false;
	let mode: VimMode = "insert";
	let baseEditor: EditorFactory | undefined;
	let editorInfo: ExternalEditorInfo = { autoDetected: false };

	const bridge: VimModeBridge = {
		isEnabled: () => enabled,
		getMode: () => mode,
		refreshStatus: (ctx) => {
			if (enabled) setVimStatus(ctx, mode);
		},
		wrapEditorFactory: (baseFactory, ctx) => createVimEditorFactory(ctx, baseFactory),
	};
	(globalThis as Record<symbol, VimModeBridge | undefined>)[VIM_BRIDGE_KEY] = bridge;

	function createVimEditorFactory(ctx: VimStatusContext, baseFactory: EditorFactory | undefined): EditorFactory {
		return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			const base = baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new VimModeEditor(
				base,
				keybindings,
				(nextMode) => {
					mode = nextMode;
					setVimStatus(ctx, nextMode);
				},
				mode,
			);
		};
	}

	function enable(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;

		if (enabled) {
			setVimStatus(ctx, mode);
			ctx.ui.notify("Vim mode 已经启用。再次输入 /vim 可退出。", "info");
			return;
		}

		baseEditor = ctx.ui.getEditorComponent() ?? getKenxStatusbarEditorFactory();
		editorInfo = ensureExternalEditor();
		mode = "insert";
		enabled = true;

		ctx.ui.setEditorComponent(createVimEditorFactory(ctx, baseEditor));
		setVimStatus(ctx, mode);

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
		ctx.ui.setEditorComponent(getKenxStatusbarEditorFactory() ?? baseEditor);
		baseEditor = undefined;
		clearVimStatus(ctx);
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
					setVimStatus(ctx, mode);
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
			clearVimStatus(ctx);
		}
		enabled = false;
		mode = "insert";
		editorInfo = { autoDetected: false };
		baseEditor = undefined;
		const globalBridge = globalThis as Record<symbol, VimModeBridge | undefined>;
		if (globalBridge[VIM_BRIDGE_KEY] === bridge) delete globalBridge[VIM_BRIDGE_KEY];
	});
}
