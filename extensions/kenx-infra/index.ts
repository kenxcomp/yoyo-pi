import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomEditor,
	getAgentDir,
	Theme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const baseDir = dirname(fileURLToPath(import.meta.url));
const themesDir = join(baseDir, "themes");
const stateDir = join(getAgentDir(), "state");
const persistedStatePath = join(stateDir, "kenx-infra.json");
const themeNames = ["paper", "light", "dark"] as const;
type KenxThemeName = (typeof themeNames)[number];
type ColorMode = "truecolor" | "256color";
type ThemeColorValue = string | number;
type ThemeBgKey = "selectedBg" | "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
type KenxThemeJson = {
	name?: string;
	vars?: Record<string, ThemeColorValue>;
	colors?: Record<string, ThemeColorValue>;
};
type ThemeBgRuntimeState = {
	enabled: boolean;
	ansi: string;
	tui?: TUI;
};
type ThemeBgPatch = {
	originalRender: TUI["render"];
	wrapper: TUI["render"];
};

type FileTreeResult =
	| { type: "select"; path: string }
	| { type: "cancel" };

type FileTreeEntry = {
	name: string;
	fullPath: string;
	kind: "file" | "dir" | "parent" | "symlink" | "other";
};

let closeFileTree: (() => void) | null = null;
let installedKenxStatusbarBridge: KenxStatusbarBridge | undefined;

const THEME_BG_WIDGET_KEY = "kenx-theme-bg-capture";
const THEME_BG_RUNTIME_STATE_KEY = Symbol.for("yoyo-pi:kenx-theme-bg-runtime-state");
const THEME_BG_PATCH_KEY = Symbol.for("yoyo-pi:kenx-theme-bg-patch");

const statusbarVariantNumbers = [1, 2, 3, 4, 5, 6, 7, 8] as const;
type StatusbarVariant = (typeof statusbarVariantNumbers)[number];
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;
type VimModeBridge = {
	isEnabled(): boolean;
	refreshStatus(ctx: ExtensionContext): void;
	wrapEditorFactory(baseFactory: EditorFactory | undefined, ctx: ExtensionContext): EditorFactory;
};
type KenxStatusbarBridge = {
	isEnabled(): boolean;
	getEditorFactory(): EditorFactory | undefined;
	setStatus(key: string, text: string | undefined): void;
};

type GitStatusSummary = {
	isRepo: boolean;
	branch?: string;
	modified: number;
	untracked: number;
};

type StatusbarState = {
	variant?: StatusbarVariant;
	cwd: string;
	modelId: string;
	modelProvider?: string;
	thinkingLevel: string;
	git: GitStatusSummary;
	theme?: Theme;
	footerBranch?: string;
	extensionStatuses: string[];
	requestRender?: () => void;
	gitRequestId: number;
};

type PersistedKenxState = {
	theme?: KenxThemeName;
	themeBg?: boolean;
	statusbarVariant?: StatusbarVariant | null;
};

const defaultGitStatus: GitStatusSummary = {
	isRepo: false,
	modified: 0,
	untracked: 0,
};

const VIM_BRIDGE_KEY = Symbol.for("yoyo-pi.vim-mode.bridge");
const KENX_STATUSBAR_BRIDGE_KEY = Symbol.for("yoyo-pi.kenx-statusbar.bridge");

const statusbarVariantLabels: Record<StatusbarVariant, string> = {
	1: "hairline rules",
	2: "rule-embedded chips",
	3: "status above input",
	4: "label pills",
	5: "corner tabs",
	6: "margin labels",
	7: "single-line dense",
	8: "badges row",
};

const statusbarState: StatusbarState = {
	cwd: process.cwd(),
	modelId: "no-model",
	thinkingLevel: "off",
	git: { ...defaultGitStatus },
	extensionStatuses: [],
	gitRequestId: 0,
};

let persistedKenxState = loadPersistedKenxState();
let activeKenxThemeName: KenxThemeName | undefined = persistedKenxState.theme;

const fgColorKeys = [
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
	"userMessageText",
	"customMessageText",
	"customMessageLabel",
	"toolTitle",
	"toolOutput",
	"mdHeading",
	"mdLink",
	"mdLinkUrl",
	"mdCode",
	"mdCodeBlock",
	"mdCodeBlockBorder",
	"mdQuote",
	"mdQuoteBorder",
	"mdHr",
	"mdListBullet",
	"toolDiffAdded",
	"toolDiffRemoved",
	"toolDiffContext",
	"syntaxComment",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxOperator",
	"syntaxPunctuation",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"bashMode",
] as const satisfies readonly ThemeColor[];

const bgColorKeys = [
	"selectedBg",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
] as const satisfies readonly ThemeBgKey[];

export default function (pi: ExtensionAPI) {
	installKenxStatusbarBridge();

	pi.on("resources_discover", () => ({
		themePaths: [themesDir],
	}));

	pi.on("session_start", async (_event, ctx) => {
		applyPersistedTheme(ctx);
		syncThemeBg(ctx);
		syncStatusbarContext(ctx, pi);
		const restoredVariant = getPersistedStatusbarVariant(ctx);
		statusbarState.variant = restoredVariant;
		if (restoredVariant) {
			applyStatusbarUI(ctx);
			void refreshGitStatus(pi, ctx.cwd);
		}
	});

	pi.on("model_select", (event, ctx) => {
		syncStatusbarContext(ctx, pi);
		statusbarState.modelId = event.model.id;
		statusbarState.modelProvider = event.model.provider;
		requestStatusbarRender();
	});

	pi.on("thinking_level_select", (event) => {
		statusbarState.thinkingLevel = event.level;
		requestStatusbarRender();
	});

	pi.on("turn_end", (_event, ctx) => {
		syncStatusbarContext(ctx, pi);
		if (statusbarState.variant) void refreshGitStatus(pi, ctx.cwd);
	});

	registerStatusbarCommand(pi, "switch-statusbar");

	pi.on("session_shutdown", () => {
		closeFileTree?.();
		closeFileTree = null;
		setThemeBgRuntimeEnabled(false);
		uninstallThemeBgPatch(false);
		statusbarState.requestRender = undefined;
		uninstallKenxStatusbarBridge();
	});

	pi.registerCommand("theme", {
		description: "Switch kenx-infra theme: paper, light, or dark",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const completions = themeNames
				.filter((name) => name.startsWith(p))
				.map((name) => ({ value: name, label: name, description: `kenx-infra ${name} palette` }));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const name = args.trim().toLowerCase() as KenxThemeName;
			if (!isKenxThemeName(name)) {
				ctx.ui.notify("Usage: /theme <paper|light|dark>", "warning");
				return;
			}

			try {
				if (!applyKenxTheme(ctx, name, true)) return;
				savePersistedKenxState({ theme: name });
				ctx.ui.notify(`Theme: ${name} (persisted)`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("theme-bg", {
		description: "Toggle kenx-infra full TUI background coverage: true or false",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				{ value: "true", label: "true", description: "cover the full TUI with the active /theme background" },
				{ value: "false", label: "false", description: "restore pi's normal transparent/default terminal background" },
				{ value: "status", label: "status", description: "show current theme-bg state" },
			];
			const completions = items.filter((item) => item.value.startsWith(p));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const parsed = parseThemeBgArg(args);
			if (parsed === "status") {
				const enabled = persistedKenxState.themeBg === true;
				ctx.ui.notify(`Theme background: ${enabled ? "true" : "false"}`, "info");
				return;
			}
			if (parsed === undefined) {
				ctx.ui.notify("Usage: /theme-bg <true|false>", "warning");
				return;
			}

			try {
				setThemeBg(ctx, parsed);
				savePersistedKenxState({ themeBg: parsed });
				ctx.ui.notify(`Theme background: ${parsed ? "true" : "false"} (persisted)`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("filetree", {
		description: "Toggle the right-side overlay file tree picker",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await toggleFileTree(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+f", {
		description: "Toggle the right-side overlay file tree picker",
		handler: toggleFileTree,
	});
}

async function toggleFileTree(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	if (closeFileTree) {
		closeFileTree();
		return;
	}

	try {
		const result = await ctx.ui.custom<FileTreeResult>(
			(tui, theme, _keybindings, done) => {
				let closed = false;
				const finish = (value: FileTreeResult) => {
					if (closed) return;
					closed = true;
					done(value);
				};

				closeFileTree = () => finish({ type: "cancel" });

				return new FileTreePanel({
					tui,
					theme,
					basePath: resolve(ctx.cwd),
					done: finish,
				});
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "28%",
					minWidth: 32,
					maxHeight: "90%",
					margin: { right: 0 },
				},
				onHandle: (handle) => {
					handle.focus();
				},
			},
		);

		if (result.type === "select") {
			ctx.ui.pasteToEditor(`@${result.path}`);
		}
	} finally {
		closeFileTree = null;
	}
}

function isKenxThemeName(value: unknown): value is KenxThemeName {
	return typeof value === "string" && (themeNames as readonly string[]).includes(value);
}

function readKenxThemeJson(name: KenxThemeName): { themePath: string; json: KenxThemeJson } {
	const themePath = join(themesDir, `${name}.json`);
	const json = JSON.parse(readFileSync(themePath, "utf8")) as KenxThemeJson;
	return { themePath, json };
}

function resolveKenxThemeValue(
	name: KenxThemeName,
	value: ThemeColorValue | undefined,
	vars: Record<string, ThemeColorValue>,
	seen = new Set<string>(),
): ThemeColorValue {
	if (value === undefined) throw new Error(`Theme ${name} is missing a color token`);
	if (typeof value === "number") return value;
	if (value === "" || value.startsWith("#")) return value;
	if (seen.has(value)) throw new Error(`Circular theme variable reference: ${value}`);
	const next = vars[value];
	if (next === undefined) throw new Error(`Unknown theme variable: ${value}`);
	seen.add(value);
	return resolveKenxThemeValue(name, next, vars, seen);
}

function loadKenxTheme(name: KenxThemeName, mode: ColorMode): Theme {
	const { themePath, json } = readKenxThemeJson(name);
	const vars = json.vars ?? {};
	const colors = json.colors ?? {};

	const fg = {} as Record<ThemeColor, ThemeColorValue>;
	for (const key of fgColorKeys) fg[key] = resolveKenxThemeValue(name, colors[key], vars);

	const bg = {} as Record<ThemeBgKey, ThemeColorValue>;
	for (const key of bgColorKeys) bg[key] = resolveKenxThemeValue(name, colors[key], vars);

	return new Theme(fg, bg, mode, { name: json.name ?? name, sourcePath: themePath });
}

function loadPersistedKenxState(): PersistedKenxState {
	try {
		const raw = JSON.parse(readFileSync(persistedStatePath, "utf8")) as {
			theme?: unknown;
			themeBg?: unknown;
			statusbarVariant?: unknown;
		};
		const numericVariant =
			typeof raw.statusbarVariant === "string" ? Number.parseInt(raw.statusbarVariant, 10) : raw.statusbarVariant;
		return {
			theme: isKenxThemeName(raw.theme) ? raw.theme : undefined,
			themeBg: typeof raw.themeBg === "boolean" ? raw.themeBg : undefined,
			statusbarVariant:
				raw.statusbarVariant === null ? null : isStatusbarVariant(numericVariant) ? numericVariant : undefined,
		};
	} catch {
		return {};
	}
}

function savePersistedKenxState(update: PersistedKenxState): void {
	persistedKenxState = { ...persistedKenxState, ...update };
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(persistedStatePath, `${JSON.stringify(persistedKenxState, null, "\t")}\n`, "utf8");
}

function applyPersistedTheme(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !persistedKenxState.theme) return;
	applyKenxTheme(ctx, persistedKenxState.theme, false);
}

function applyKenxTheme(ctx: ExtensionContext, name: KenxThemeName, notifyErrors: boolean): boolean {
	if (!ctx.hasUI) return false;
	try {
		const mode = ctx.ui.theme.getColorMode() as ColorMode;
		const result = ctx.ui.setTheme(loadKenxTheme(name, mode));
		if (!result.success) {
			if (notifyErrors) ctx.ui.notify(`Failed to switch theme: ${result.error ?? "unknown error"}`, "error");
			return false;
		}
		activeKenxThemeName = name;
		statusbarState.theme = ctx.ui.theme;
		updateThemeBgAnsi(ctx, name);
		requestStatusbarRender();
		return true;
	} catch (error) {
		if (notifyErrors) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}
}

function parseThemeBgArg(args: string): boolean | "status" | undefined {
	const value = args.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["true", "on", "1", "yes", "enable", "enabled"].includes(value)) return true;
	if (["false", "off", "0", "no", "disable", "disabled"].includes(value)) return false;
	return undefined;
}

function syncThemeBg(ctx: ExtensionContext): void {
	if (persistedKenxState.themeBg === true) {
		try {
			setThemeBg(ctx, true);
		} catch (error) {
			setThemeBgRuntimeEnabled(false);
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	setThemeBgRuntimeEnabled(false);
	if (ctx.hasUI) ctx.ui.setWidget(THEME_BG_WIDGET_KEY, undefined);
	uninstallThemeBgPatch(false);
}

function setThemeBg(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) {
		setThemeBgRuntimeEnabled(enabled);
		return;
	}

	if (!enabled) {
		setThemeBgRuntimeEnabled(false);
		ctx.ui.setWidget(THEME_BG_WIDGET_KEY, undefined);
		uninstallThemeBgPatch(true);
		return;
	}

	if (!updateThemeBgAnsi(ctx)) {
		throw new Error("Use /theme <paper|light|dark> before /theme-bg true");
	}

	setThemeBgRuntimeEnabled(true);
	ctx.ui.setWidget(THEME_BG_WIDGET_KEY, (tui) => new ThemeBgCaptureWidget(tui));
	getThemeBgRuntimeState().tui?.requestRender(true);
}

class ThemeBgCaptureWidget {
	constructor(private readonly tui: TUI) {
		installThemeBgPatch(tui);
	}

	render(_width: number): string[] {
		return [];
	}

	invalidate(): void {
		installThemeBgPatch(this.tui);
	}
}

function getThemeBgRuntimeState(): ThemeBgRuntimeState {
	const globals = globalThis as unknown as Record<PropertyKey, ThemeBgRuntimeState | undefined>;
	let state = globals[THEME_BG_RUNTIME_STATE_KEY];
	if (!state) {
		state = { enabled: false, ansi: "" };
		globals[THEME_BG_RUNTIME_STATE_KEY] = state;
	}
	return state;
}

function setThemeBgRuntimeEnabled(enabled: boolean): void {
	getThemeBgRuntimeState().enabled = enabled;
}

function installThemeBgPatch(tui: TUI): void {
	const state = getThemeBgRuntimeState();
	state.tui = tui;
	const target = tui as TUI & Record<PropertyKey, ThemeBgPatch | undefined>;
	if (target[THEME_BG_PATCH_KEY]) {
		tui.requestRender(true);
		return;
	}

	const originalRender = tui.render;
	const wrapper: TUI["render"] = function (this: TUI, width: number): string[] {
		const lines = originalRender.call(this, width);
		const runtime = getThemeBgRuntimeState();
		if (!runtime.enabled || !runtime.ansi) return lines;

		const safeWidth = Math.max(1, width);
		const rendered = lines.map((line) => applyThemeBgToLine(line, safeWidth, runtime.ansi));
		const minLines = Math.max(rendered.length, this.terminal.rows || 0);
		while (rendered.length < minLines) rendered.push(applyThemeBgToLine("", safeWidth, runtime.ansi));
		return rendered;
	};

	target[THEME_BG_PATCH_KEY] = { originalRender, wrapper };
	tui.render = wrapper;
	tui.requestRender(true);
}

function uninstallThemeBgPatch(forceRender: boolean): void {
	const state = getThemeBgRuntimeState();
	const tui = state.tui;
	if (!tui) return;

	const target = tui as TUI & Record<PropertyKey, ThemeBgPatch | undefined>;
	const patch = target[THEME_BG_PATCH_KEY];
	if (patch && tui.render === patch.wrapper) {
		tui.render = patch.originalRender;
		delete target[THEME_BG_PATCH_KEY];
	}
	state.tui = undefined;
	if (forceRender) tui.requestRender(true);
}

function applyThemeBgToLine(line: string, width: number, bgAnsi: string): string {
	if (line.startsWith("\x1b_G")) return line;
	const content = visibleWidth(line) > width ? truncateToWidth(line, width, "", true) : line;
	const withAmbientBg = reapplyThemeBgAfterReset(content, bgAnsi);
	const pad = Math.max(0, width - visibleWidth(content));
	return `${bgAnsi}${withAmbientBg}${" ".repeat(pad)}\x1b[49m`;
}

function reapplyThemeBgAfterReset(line: string, bgAnsi: string): string {
	return line.replace(/\x1b\[([0-9;]*)m/g, (sequence: string, rawCodes: string) => {
		const codes = rawCodes === "" ? [0] : rawCodes.split(";").map((code) => Number.parseInt(code, 10));
		const resetsBackground = codes.includes(0) || codes.includes(49);
		const setsBackground = codes.some((code) => code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107));
		return resetsBackground && !setsBackground ? `${sequence}${bgAnsi}` : sequence;
	});
}

function updateThemeBgAnsi(ctx: ExtensionContext, name?: KenxThemeName): boolean {
	if (!ctx.hasUI) return false;
	const themeName = name ?? getThemeBgName(ctx);
	if (!themeName) return false;
	const mode = ctx.ui.theme.getColorMode() as ColorMode;
	getThemeBgRuntimeState().ansi = getKenxThemeBgAnsi(themeName, mode);
	return true;
}

function getThemeBgName(ctx: ExtensionContext): KenxThemeName | undefined {
	const currentThemeName = ctx.hasUI ? ctx.ui.theme.name : undefined;
	if (isKenxThemeName(currentThemeName)) return currentThemeName;
	return activeKenxThemeName ?? persistedKenxState.theme;
}

function getKenxThemeBgAnsi(name: KenxThemeName, mode: ColorMode): string {
	const { json } = readKenxThemeJson(name);
	const vars = json.vars ?? {};
	if (vars.bg === undefined) throw new Error(`Theme ${name} is missing vars.bg for full background`);
	return colorValueToBgAnsi(resolveKenxThemeValue(name, vars.bg, vars), mode);
}

function colorValueToBgAnsi(value: ThemeColorValue, mode: ColorMode): string {
	if (value === "") return "\x1b[49m";
	if (typeof value === "number") return `\x1b[48;5;${value}m`;
	if (!value.startsWith("#")) throw new Error(`Invalid background color value: ${value}`);
	const { r, g, b } = hexToRgb(value);
	if (mode === "truecolor") return `\x1b[48;2;${r};${g};${b}m`;
	return `\x1b[48;5;${rgbToAnsi256(r, g, b)}m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (!/^[0-9a-f]{6}$/i.test(cleaned)) throw new Error(`Invalid hex color: ${hex}`);
	return {
		r: Number.parseInt(cleaned.slice(0, 2), 16),
		g: Number.parseInt(cleaned.slice(2, 4), 16),
		b: Number.parseInt(cleaned.slice(4, 6), 16),
	};
}

function rgbToAnsi256(r: number, g: number, b: number): number {
	const levels = [0, 95, 135, 175, 215, 255];
	const nearest = (value: number) => {
		let best = 0;
		let bestDistance = Infinity;
		for (let i = 0; i < levels.length; i++) {
			const distance = Math.abs(value - (levels[i] ?? 0));
			if (distance < bestDistance) {
				best = i;
				bestDistance = distance;
			}
		}
		return best;
	};
	const ri = nearest(r);
	const gi = nearest(g);
	const bi = nearest(b);
	return 16 + 36 * ri + 6 * gi + bi;
}

function getPersistedStatusbarVariant(ctx: ExtensionContext): StatusbarVariant | undefined {
	if ("statusbarVariant" in persistedKenxState) {
		return persistedKenxState.statusbarVariant ?? undefined;
	}
	return getRestoredStatusbarVariant(ctx);
}

type StatusbarRenderData = {
	path: string;
	compactPath: string;
	model: string;
	strength: string;
	branch?: string;
	modified: number;
	untracked: number;
	isRepo: boolean;
	statuses: string[];
};

function registerStatusbarCommand(pi: ExtensionAPI, name: "switch-statusbar"): void {
	pi.registerCommand(name, {
		description: "Switch kenx-infra input/statusbar UI (1-8). Use 0/off to restore default.",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				...statusbarVariantNumbers.map((variant) => ({
					value: String(variant),
					label: String(variant),
					description: statusbarVariantLabels[variant],
				})),
				{ value: "0", label: "0", description: "restore pi default input/footer" },
			];
			const completions = items.filter((item) => item.value.startsWith(p) || item.description.includes(p));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const parsed = parseStatusbarArg(args);
			if (parsed === undefined) {
				ctx.ui.notify("Usage: /switch-statusbar <1-8> (or 0/off to restore default)", "warning");
				return;
			}

			syncStatusbarContext(ctx, pi);
			if (parsed === 0) {
				statusbarState.variant = undefined;
				const vimBridge = getVimModeBridge();
				vimBridge?.refreshStatus(ctx);
				ctx.ui.setEditorComponent(vimBridge?.wrapEditorFactory(undefined, ctx));
				ctx.ui.setFooter(undefined);
				statusbarState.requestRender = undefined;
				savePersistedKenxState({ statusbarVariant: null });
				pi.appendEntry("kenx-statusbar", { variant: null });
				ctx.ui.notify("Statusbar: default (persisted)", "info");
				return;
			}

			statusbarState.variant = parsed;
			applyStatusbarUI(ctx);
			savePersistedKenxState({ statusbarVariant: parsed });
			pi.appendEntry("kenx-statusbar", { variant: parsed });
			void refreshGitStatus(pi, ctx.cwd);
			ctx.ui.notify(`Statusbar ${parsed}: ${statusbarVariantLabels[parsed]} (persisted)`, "info");
		},
	});
}

function parseStatusbarArg(args: string): StatusbarVariant | 0 | undefined {
	const value = args.trim().toLowerCase();
	if (value === "0" || value === "off" || value === "default" || value === "reset") return 0;
	const numeric = Number.parseInt(value, 10);
	return isStatusbarVariant(numeric) ? numeric : undefined;
}

function isStatusbarVariant(value: unknown): value is StatusbarVariant {
	return typeof value === "number" && (statusbarVariantNumbers as readonly number[]).includes(value);
}

function getRestoredStatusbarVariant(ctx: ExtensionContext): StatusbarVariant | undefined {
	let restored: StatusbarVariant | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "kenx-statusbar") continue;
		const value = (entry.data as { variant?: unknown } | undefined)?.variant;
		const numeric = typeof value === "string" ? Number.parseInt(value, 10) : value;
		restored = isStatusbarVariant(numeric) ? numeric : undefined;
	}
	return restored;
}

function syncStatusbarContext(ctx: ExtensionContext, pi: ExtensionAPI): void {
	statusbarState.cwd = ctx.cwd;
	statusbarState.modelId = ctx.model?.id ?? "no-model";
	statusbarState.modelProvider = ctx.model?.provider;
	statusbarState.thinkingLevel = pi.getThinkingLevel();
	if (ctx.hasUI) statusbarState.theme = ctx.ui.theme;
}

function requestStatusbarRender(): void {
	statusbarState.requestRender?.();
}

async function refreshGitStatus(pi: ExtensionAPI, cwd: string): Promise<void> {
	const requestId = ++statusbarState.gitRequestId;
	try {
		const result = await pi.exec("git", ["status", "--short", "--branch"], { cwd, timeout: 2000 });
		if (requestId !== statusbarState.gitRequestId) return;
		if (result.code !== 0) {
			setGitStatus({ ...defaultGitStatus });
			return;
		}
		setGitStatus(parseGitStatus(result.stdout));
	} catch {
		if (requestId === statusbarState.gitRequestId) setGitStatus({ ...defaultGitStatus });
	}
}

function setGitStatus(next: GitStatusSummary): void {
	const current = statusbarState.git;
	if (
		current.isRepo === next.isRepo &&
		current.branch === next.branch &&
		current.modified === next.modified &&
		current.untracked === next.untracked
	) {
		return;
	}
	statusbarState.git = next;
	requestStatusbarRender();
}

function parseGitStatus(stdout: string): GitStatusSummary {
	const summary: GitStatusSummary = { isRepo: true, modified: 0, untracked: 0 };
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		if (line.startsWith("## ")) {
			summary.branch = parseGitBranch(line);
			continue;
		}
		if (line.startsWith("??")) summary.untracked++;
		else summary.modified++;
	}
	return summary;
}

function parseGitBranch(line: string): string | undefined {
	let branch = line.slice(3).trim();
	branch = branch.replace(/\s+\[.*\]$/, "");
	const upstreamIndex = branch.indexOf("...");
	if (upstreamIndex >= 0) branch = branch.slice(0, upstreamIndex);
	if (branch === "HEAD (no branch)") branch = "detached";
	return branch || undefined;
}

function getVimModeBridge(): VimModeBridge | undefined {
	const bridge = (globalThis as Record<symbol, VimModeBridge | undefined>)[VIM_BRIDGE_KEY];
	return bridge?.isEnabled() ? bridge : undefined;
}

function createStatusbarEditorFactory(): EditorFactory {
	return (tui, editorTheme, keybindings) => new StatusbarEditor(tui, editorTheme, keybindings, statusbarState);
}

function createComposedStatusbarEditorFactory(ctx: ExtensionContext): EditorFactory {
	const statusbarFactory = createStatusbarEditorFactory();
	const vimBridge = getVimModeBridge();
	vimBridge?.refreshStatus(ctx);
	return vimBridge?.wrapEditorFactory(statusbarFactory, ctx) ?? statusbarFactory;
}

function setKnownExtensionStatus(key: string, text: string | undefined): void {
	if (key !== "vim-mode") return;
	const withoutVim = statusbarState.extensionStatuses.filter((status) => !status.startsWith("VIM "));
	const cleaned = text ? sanitizeStatusText(text) : "";
	statusbarState.extensionStatuses = cleaned ? [...withoutVim, cleaned] : withoutVim;
	requestStatusbarRender();
}

function installKenxStatusbarBridge(): void {
	const bridge: KenxStatusbarBridge = {
		isEnabled: () => Boolean(statusbarState.variant),
		getEditorFactory: () => (statusbarState.variant ? createStatusbarEditorFactory() : undefined),
		setStatus: setKnownExtensionStatus,
	};
	installedKenxStatusbarBridge = bridge;
	(globalThis as Record<symbol, KenxStatusbarBridge | undefined>)[KENX_STATUSBAR_BRIDGE_KEY] = bridge;
}

function uninstallKenxStatusbarBridge(): void {
	const globalBridge = globalThis as Record<symbol, KenxStatusbarBridge | undefined>;
	if (globalBridge[KENX_STATUSBAR_BRIDGE_KEY] === installedKenxStatusbarBridge) delete globalBridge[KENX_STATUSBAR_BRIDGE_KEY];
	installedKenxStatusbarBridge = undefined;
}

function applyStatusbarUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	statusbarState.theme = ctx.ui.theme;

	if (!statusbarState.variant) {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
		statusbarState.requestRender = undefined;
		return;
	}

	ctx.ui.setEditorComponent(createComposedStatusbarEditorFactory(ctx));
	ctx.ui.setFooter((tui, theme, footerData) => new StatusbarFooterSilencer(tui, theme, footerData, statusbarState));
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function readExtensionStatuses(footerData: { getExtensionStatuses(): ReadonlyMap<string, string> }): string[] {
	return Array.from(footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean);
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

class StatusbarFooterSilencer {
	private readonly requestRender: () => void;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly footerData: {
			getGitBranch(): string | null;
			getExtensionStatuses(): ReadonlyMap<string, string>;
			onBranchChange(callback: () => void): () => void;
		},
		private readonly state: StatusbarState,
	) {
		this.requestRender = () => this.tui.requestRender();
		this.state.theme = this.theme;
		this.state.footerBranch = this.footerData.getGitBranch() ?? undefined;
		this.state.extensionStatuses = readExtensionStatuses(this.footerData);
		this.state.requestRender = this.requestRender;
		this.unsubscribe = this.footerData.onBranchChange(() => {
			this.state.footerBranch = this.footerData.getGitBranch() ?? undefined;
			this.tui.requestRender();
		});
	}

	render(): string[] {
		this.state.theme = this.theme;
		this.state.footerBranch = this.footerData.getGitBranch() ?? undefined;
		const extensionStatuses = readExtensionStatuses(this.footerData);
		if (!sameStringArray(this.state.extensionStatuses, extensionStatuses)) {
			this.state.extensionStatuses = extensionStatuses;
			this.tui.requestRender();
		}
		return [];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		if (this.state.requestRender === this.requestRender) this.state.requestRender = undefined;
	}
}

class StatusbarEditor extends CustomEditor {
	private readonly requestRender: () => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly statusbarState: StatusbarState,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.requestRender = () => tui.requestRender();
		this.statusbarState.requestRender = this.requestRender;
	}

	dispose(): void {
		if (this.statusbarState.requestRender === this.requestRender) this.statusbarState.requestRender = undefined;
	}

	render(width: number): string[] {
		const theme = this.statusbarState.theme;
		const variant = this.statusbarState.variant;
		if (!theme || !variant) return super.render(width);

		const w = Math.max(1, width);
		const data = getStatusbarRenderData(this.statusbarState);
		const lines = this.renderVariant(variant, theme, data, w);
		return fitStatusbarLines(lines, w);
	}

	private renderVariant(variant: StatusbarVariant, theme: Theme, data: StatusbarRenderData, width: number): string[] {
		switch (variant) {
			case 1:
				return this.renderHairline(theme, data, width);
			case 2:
				return this.renderChips(theme, data, width);
			case 3:
				return this.renderStatusAbove(theme, data, width);
			case 4:
				return this.renderPills(theme, data, width);
			case 5:
				return this.renderCornerTabs(theme, data, width);
			case 6:
				return this.renderMarginLabels(theme, data, width);
			case 7:
				return this.renderDense(theme, data, width);
			case 8:
				return this.renderBadges(theme, data, width);
		}
		return this.renderHairline(theme, data, width);
	}

	private renderHairline(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		return [
			rule(theme, width),
			...this.inputRows(theme, Math.max(1, width), true),
			rule(theme, width),
			"",
			" " + lr(statusLeft(theme, data), statusRight(theme, data) + " ", Math.max(1, width - 1)),
		];
	}

	private renderChips(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const contentWidth = Math.max(1, inner - 2);
		const lines = [border(theme, `╭${"─".repeat(inner)}╮`)];
		for (const line of this.inputRows(theme, contentWidth, true)) {
			lines.push(border(theme, "│ ") + padLine(line, contentWidth) + border(theme, " │"));
		}
		lines.push(border(theme, "│") + " ".repeat(inner) + border(theme, "│"));
		lines.push(border(theme, "╰") + embeddedChipLine(theme, data, inner) + border(theme, "╯"));
		return lines;
	}

	private renderStatusAbove(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const boxWidth = Math.max(1, width - 4);
		const inner = Math.max(1, boxWidth - 2);
		const contentWidth = Math.max(1, inner - 2);
		const lines = [
			"  " + lr(statusLeft(theme, data, "in"), statusRight(theme, data, "using") + "  ", Math.max(1, width - 2)),
			"",
			"  " + border(theme, `╭${"─".repeat(inner)}╮`),
		];
		for (const line of this.inputRows(theme, contentWidth, true)) {
			lines.push("  " + border(theme, "│ ") + padLine(line, contentWidth) + border(theme, " │"));
		}
		lines.push("  " + border(theme, `╰${"─".repeat(inner)}╯`));
		lines.push("  " + lr("", statusHints(theme), Math.max(1, width - 2)));
		return lines;
	}

	private renderPills(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const p1 = pill(theme, "selectedBg", "muted", ` ${data.path} `);
		const p2 = data.branch
			? pill(theme, "toolSuccessBg", "success", ` ⎇ ${data.branch} `) + gitCountPills(theme, data)
			: pill(theme, "selectedBg", "dim", " no git ");
		const statusPills = extensionStatusPills(theme, data);
		const modelPills = pill(theme, "toolErrorBg", "accent", ` ${data.model} `) + " " + pill(theme, "selectedBg", "warning", ` ${data.strength} `);
		const p3 = statusPills ? `${statusPills} ${modelPills}` : modelPills;
		return [
			dottedRule(theme, width),
			...this.inputRows(theme, Math.max(1, width), true),
			dottedRule(theme, width),
			"",
			" " + lr(`${p1}  ${p2}`, p3 + " ", Math.max(1, width - 1)),
		];
	}

	private renderCornerTabs(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const contentWidth = Math.max(1, inner - 4);
		const topLeft = `${border(theme, "─ ")}${theme.fg("dim", "chat")} `;
		const topModel = `${theme.bold(data.model)} ${theme.fg("dim", "·")} ${strengthText(theme, data.strength)}`;
		const topRight = ` ${withExtensionStatuses(theme, data, topModel)} ${border(theme, "─")}`;
		const bottomLeft = `${border(theme, "─ ")}${theme.fg("dim", data.path)} `;
		const bottomRight = data.branch ? ` ${branchText(theme, data)} ${border(theme, "─")}` : ` ${theme.fg("dim", "no git")} ${border(theme, "─")}`;
		const lines = [border(theme, "╭") + lrFill(topLeft, topRight, inner, "─", theme) + border(theme, "╮")];
		lines.push(border(theme, "│") + " ".repeat(inner) + border(theme, "│"));
		for (const line of this.inputRows(theme, contentWidth, true)) {
			lines.push(border(theme, "│  ") + padLine(line, contentWidth) + border(theme, "  │"));
		}
		lines.push(border(theme, "│") + " ".repeat(inner) + border(theme, "│"));
		lines.push(border(theme, "╰") + lrFill(bottomLeft, bottomRight, inner, "─", theme) + border(theme, "╯"));
		return lines;
	}

	private renderMarginLabels(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const margin = Math.min(22, Math.max(8, Math.floor(width * 0.28)));
		const field = Math.max(1, width - margin - 3);
		const m = (text: string) => padLine(text, margin);
		const input = this.inputRows(theme, field, false);
		const lines = [m(theme.fg("dim", "path")) + border(theme, "╴") + "  " + (input[0] ?? "")];
		for (const extra of input.slice(1)) lines.push(m("") + "   " + extra);
		lines.push(m(theme.fg("muted", data.path)) + rule(theme, Math.max(1, width - margin)));
		lines.push("");
		lines.push(m(theme.fg("dim", "branch")) + " ");
		lines.push(m(data.branch ? branchText(theme, data) : theme.fg("dim", "no git")) + " ");
		const statuses = extensionStatusTags(theme, data);
		if (statuses) {
			lines.push("");
			lines.push(m(theme.fg("dim", "status")) + " ");
			lines.push(m(statuses) + " ");
		}
		lines.push("");
		lines.push(m(theme.fg("dim", "model")) + lr("", statusHints(theme), Math.max(1, width - margin)));
		lines.push(m(`${theme.bold(data.model)} ${theme.fg("dim", "·")} ${strengthText(theme, data.strength)}`) + " ");
		return lines;
	}

	private renderDense(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const left = `${theme.fg("muted", data.compactPath)}  ${theme.fg("dim", "│")}  ${data.branch ? branchText(theme, data) : theme.fg("dim", "no git")}`;
		const model = `${theme.bold(data.model)} ${theme.fg("dim", "·")} ${strengthText(theme, data.strength)}`;
		const right = withExtensionStatuses(theme, data, model);
		return [
			" " + lr(left, right + " ", Math.max(1, width - 1)),
			rule(theme, width),
			...this.inputRows(theme, Math.max(1, width), true),
			" " + lr("", statusHints(theme) + " ", Math.max(1, width - 1)),
		];
	}

	private renderBadges(theme: Theme, data: StatusbarRenderData, width: number): string[] {
		const boxWidth = Math.max(1, width - 4);
		const inner = Math.max(1, boxWidth - 2);
		const contentWidth = Math.max(1, inner - 2);
		const lines = ["  " + border(theme, `╭${"─".repeat(inner)}╮`)];
		for (const line of this.inputRows(theme, contentWidth, true)) {
			lines.push("  " + border(theme, "│ ") + padLine(line, contentWidth) + border(theme, " │"));
		}
		lines.push("  " + border(theme, `╰${"─".repeat(inner)}╯`));
		lines.push("");
		const b1 = `${theme.fg("dim", "❯")} ${theme.fg("muted", data.path)}`;
		const b2 = data.branch ? branchText(theme, data, false) : theme.fg("dim", "no git");
		const b3 = `${theme.fg("warning", "✚")}${data.modified} ${theme.fg("error", "?")}${data.untracked}`;
		const badgeModel = `${theme.bold(data.model)} ${theme.fg("dim", "/")} ${strengthText(theme, data.strength)}`;
		const b4 = `${theme.fg("dim", "◆")} ${withExtensionStatuses(theme, data, badgeModel)}`;
		lines.push("  " + lr(`${b1}   ${theme.fg("dim", "·")}   ${b2}   ${theme.fg("dim", "·")}   ${b3}`, b4 + "  ", Math.max(1, width - 2)));
		return lines;
	}

	private inputRows(theme: Theme, width: number, prompt: boolean): string[] {
		const safeWidth = Math.max(1, width);
		const promptText = prompt ? ` ${theme.fg("accent", theme.bold("›"))}  ` : "";
		const nextPrefix = prompt ? "    " : "";
		const bodyWidth = Math.max(1, safeWidth - visibleWidth(promptText));
		const raw = super.render(bodyWidth);
		const bottomIndex = findEditorBottomIndex(raw);
		const body = raw.slice(1, bottomIndex);
		const autocomplete = raw.slice(bottomIndex + 1);
		const rows = (body.length > 0 ? body : [""]).map((line, index) =>
			padLine((index === 0 ? promptText : nextPrefix) + line, safeWidth),
		);
		for (const line of autocomplete) rows.push(padLine(nextPrefix + line, safeWidth));
		return rows;
	}
}

function getStatusbarRenderData(state: StatusbarState): StatusbarRenderData {
	const branch = state.footerBranch ?? state.git.branch;
	return {
		path: formatCwdPath(state.cwd, 3),
		compactPath: formatCwdPath(state.cwd, 2, true),
		model: state.modelId || "no-model",
		strength: state.thinkingLevel || "off",
		branch,
		modified: state.git.modified,
		untracked: state.git.untracked,
		isRepo: state.git.isRepo || Boolean(branch),
		statuses: state.extensionStatuses,
	};
}

function formatCwdPath(cwd: string, maxSegments: number, forceCompact = false): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	let display = cwd;
	if (home) {
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const rel = relative(resolvedHome, resolvedCwd);
		const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
		if (insideHome) display = rel ? `~${sep}${rel}` : "~";
	}
	display = display.split(sep).join("/");
	const prefix = display.startsWith("~/") ? "~/" : display.startsWith("/") ? "/" : "";
	const body = prefix ? display.slice(prefix.length) : display;
	const segments = body.split("/").filter(Boolean);
	if ((forceCompact || segments.length > maxSegments) && segments.length > maxSegments) {
		return `${prefix}…/${segments.slice(-maxSegments).join("/")}`;
	}
	return display;
}

function statusLeft(theme: Theme, data: StatusbarRenderData, label?: string): string {
	const prefix = label ? `${theme.fg("dim", label)} ` : "";
	const git = data.branch ? `  ${theme.fg("dim", "·")}  ${branchText(theme, data)}` : "";
	return `${prefix}${theme.fg("muted", data.path)}${git}`;
}

function extensionStatusTags(theme: Theme, data: StatusbarRenderData): string {
	if (data.statuses.length === 0) return "";
	return data.statuses.map((status) => theme.fg("accent", status)).join(` ${theme.fg("dim", "·")} `);
}

function extensionStatusPills(theme: Theme, data: StatusbarRenderData): string {
	if (data.statuses.length === 0) return "";
	return data.statuses.map((status) => pill(theme, "selectedBg", "accent", ` ${status} `)).join(" ");
}

function withExtensionStatuses(theme: Theme, data: StatusbarRenderData, text: string): string {
	const statuses = extensionStatusTags(theme, data);
	return statuses ? `${statuses} ${theme.fg("dim", "·")} ${text}` : text;
}

function statusRight(theme: Theme, data: StatusbarRenderData, label?: string): string {
	const prefix = label ? `${theme.fg("dim", label)} ` : `${theme.fg("dim", "model")} `;
	const model = `${theme.bold(data.model)} ${theme.fg("dim", "·")} ${strengthText(theme, data.strength)}`;
	return `${prefix}${withExtensionStatuses(theme, data, model)}`;
}

function branchText(theme: Theme, data: StatusbarRenderData, includeCounts = true): string {
	const parts = [`${theme.fg("success", "⎇")} ${theme.fg("text", theme.bold(data.branch ?? ""))}`];
	if (includeCounts && data.modified > 0) parts.push(theme.fg("warning", `✚${data.modified}`));
	if (includeCounts && data.untracked > 0) parts.push(theme.fg("error", `?${data.untracked}`));
	return parts.join(" ");
}

function gitCountPills(theme: Theme, data: StatusbarRenderData): string {
	const parts: string[] = [];
	if (data.modified > 0) parts.push(pill(theme, "toolPendingBg", "warning", ` ✚${data.modified} `));
	if (data.untracked > 0) parts.push(pill(theme, "toolErrorBg", "error", ` ?${data.untracked} `));
	return parts.length > 0 ? " " + parts.join(" ") : "";
}

function statusHints(theme: Theme): string {
	return `${theme.fg("muted", "[/]")} ${theme.fg("dim", "cmds")} ${theme.fg("dim", "·")} ${theme.fg("muted", "[@]")} ${theme.fg("dim", "files")} ${theme.fg("dim", "·")} ${theme.fg("muted", "[⏎]")} ${theme.fg("dim", "send")}`;
}

function strengthText(theme: Theme, strength: string): string {
	const key = thinkingColorFor(strength);
	return theme.fg(key, strength);
}

function thinkingColorFor(strength: string): ThemeColor {
	switch (strength) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		default:
			return "warning";
	}
}

function embeddedChipLine(theme: Theme, data: StatusbarRenderData, width: number): string {
	const seg1 = ` ${theme.fg("muted", data.path)} `;
	const seg2 = data.branch ? ` ${branchText(theme, data)} ` : ` ${theme.fg("dim", "no git")} `;
	const model = `${theme.bold(data.model)} ${theme.fg("dim", "·")} ${strengthText(theme, data.strength)}`;
	const seg3 = ` ${withExtensionStatuses(theme, data, model)} `;
	const left = `${border(theme, "─")}${seg1}${border(theme, "─")}${seg2}${border(theme, "─")}`;
	const right = `${border(theme, "─")}${seg3}${border(theme, "─")}`;
	return lrFill(left, right, width, "─", theme);
}

function pill(theme: Theme, bg: ThemeBgKey, fg: ThemeColor, text: string): string {
	return theme.bg(bg, theme.fg(fg, text));
}

function border(theme: Theme, text: string): string {
	return theme.fg("border", text);
}

function rule(theme: Theme, width: number): string {
	return border(theme, "─".repeat(Math.max(0, width)));
}

function dottedRule(theme: Theme, width: number): string {
	return theme.fg("border", truncateToWidth("╴ ".repeat(Math.ceil(width / 2)), width, "", true));
}

function lr(left: string, right: string, width: number): string {
	return lrFill(left, right, width, " ");
}

function lrFill(left: string, right: string, width: number, fill: string, theme?: Theme): string {
	const safeWidth = Math.max(1, width);
	let l = left;
	let r = right;
	if (visibleWidth(r) > safeWidth) r = truncateToWidth(r, safeWidth, "…");
	const availableLeft = Math.max(0, safeWidth - visibleWidth(r) - 1);
	if (visibleWidth(l) > availableLeft) l = truncateToWidth(l, availableLeft, "…");
	const gap = Math.max(1, safeWidth - visibleWidth(l) - visibleWidth(r));
	const filler = fill.repeat(gap);
	return l + (theme ? border(theme, filler) : filler) + r;
}

function padLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…", true);
}

function fitStatusbarLines(lines: string[], width: number): string[] {
	return lines.map((line) => (line === "" ? "" : truncateToWidth(line, width, "…", true)));
}

function findEditorBottomIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (stripAnsi(lines[i] ?? "").includes("─")) return i;
	}
	return Math.max(1, lines.length - 1);
}

function stripAnsi(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b_[\s\S]*?\x1b\\/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[@-Z\\-_]/g, "");
}

class FileTreePanel {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly basePath: string;
	private readonly done: (result: FileTreeResult) => void;

	private currentPath: string;
	private entries: FileTreeEntry[] = [];
	private selected = 0;
	private scroll = 0;
	private loading = false;
	private error: string | undefined;
	private disposed = false;
	private loadVersion = 0;
	private closed = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		basePath: string;
		done: (result: FileTreeResult) => void;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.basePath = options.basePath;
		this.currentPath = options.basePath;
		this.done = options.done;
		void this.loadDirectory(this.currentPath);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+shift+f")) {
			this.close({ type: "cancel" });
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.moveSelection(-this.visibleEntryRows());
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.moveSelection(this.visibleEntryRows());
			return;
		}
		if (matchesKey(data, "home")) {
			this.selected = 0;
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			this.selected = Math.max(0, this.entries.length - 1);
			this.ensureVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "backspace") || data === "h") {
			void this.goParent();
			return;
		}
		if (matchesKey(data, "right") || data === "l") {
			const entry = this.entries[this.selected];
			if (entry?.kind === "dir") void this.loadDirectory(entry.fullPath);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			void this.activateSelection();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const w = Math.max(24, width);
		const innerW = Math.max(1, w - 2);
		const entryRows = this.visibleEntryRows();
		this.ensureVisible(entryRows);

		const border = (s: string) => th.fg("border", s);
		const row = (content: string) => border("│") + this.pad(content, innerW) + border("│");
		const title = " FILES ";
		const titleW = visibleWidth(title);
		const leftRule = "─".repeat(Math.max(0, Math.floor((innerW - titleW) / 2)));
		const rightRule = "─".repeat(Math.max(0, innerW - titleW - leftRule.length));
		const lines: string[] = [
			border(`╭${leftRule}`) + th.fg("accent", title) + border(`${rightRule}╮`),
			row(` ${th.fg("dim", "cwd")} ${th.fg("accent", this.relativeCurrentPath())}`),
			border("├") + border("─".repeat(innerW)) + border("┤"),
		];

		if (this.loading) {
			lines.push(...this.fillRows(entryRows, ` ${th.fg("warning", "loading…")}`, row));
		} else if (this.error) {
			lines.push(...this.fillRows(entryRows, ` ${th.fg("error", this.error)}`, row));
		} else if (this.entries.length === 0) {
			lines.push(...this.fillRows(entryRows, ` ${th.fg("dim", "(empty directory)")}`, row));
		} else {
			const visible = this.entries.slice(this.scroll, this.scroll + entryRows);
			for (let i = 0; i < entryRows; i++) {
				const entry = visible[i];
				if (!entry) {
					lines.push(row(""));
					continue;
				}
				const index = this.scroll + i;
				lines.push(this.renderEntryRow(entry, index === this.selected, innerW, row));
			}
		}

		const position = this.entries.length > 0 ? `${this.selected + 1}/${this.entries.length}` : "0/0";
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(row(` ${th.fg("dim", "↑↓ select • Enter insert • →/l open • Ctrl+Shift+F close")} ${th.fg("accent", position)}`));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
	}

	private async loadDirectory(dirPath: string): Promise<void> {
		const requested = resolve(dirPath);
		if (!this.isInsideBase(requested)) return;

		const version = ++this.loadVersion;
		this.loading = true;
		this.error = undefined;
		this.tui.requestRender();

		try {
			const dirents = await readdir(requested, { withFileTypes: true });
			if (this.disposed || version !== this.loadVersion) return;

			const entries: FileTreeEntry[] = [];
			if (requested !== this.basePath) {
				entries.push({ name: "..", fullPath: dirname(requested), kind: "parent" });
			}

			for (const dirent of dirents) {
				const name = cleanName(dirent.name);
				if (!name) continue;
				const fullPath = join(requested, dirent.name);
				const kind: FileTreeEntry["kind"] = dirent.isDirectory()
					? "dir"
					: dirent.isFile()
						? "file"
						: dirent.isSymbolicLink()
							? "symlink"
							: "other";
				entries.push({ name, fullPath, kind });
			}

			entries.sort(compareEntries);
			this.currentPath = requested;
			this.entries = entries;
			this.selected = 0;
			this.scroll = 0;
		} catch (error) {
			if (this.disposed || version !== this.loadVersion) return;
			this.entries = [];
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (!this.disposed && version === this.loadVersion) {
				this.loading = false;
				this.ensureVisible();
				this.tui.requestRender();
			}
		}
	}

	private async activateSelection(): Promise<void> {
		const entry = this.entries[this.selected];
		if (!entry) return;

		if (entry.kind === "parent") {
			await this.goParent();
			return;
		}

		this.close({ type: "select", path: this.referencePath(entry.fullPath) });
	}

	private async goParent(): Promise<void> {
		if (this.currentPath === this.basePath) return;
		await this.loadDirectory(dirname(this.currentPath));
	}

	private close(result: FileTreeResult): void {
		if (this.closed) return;
		this.closed = true;
		this.done(result);
	}

	private moveSelection(delta: number): void {
		if (this.entries.length === 0) return;
		this.selected = Math.max(0, Math.min(this.entries.length - 1, this.selected + delta));
		this.ensureVisible();
		this.tui.requestRender();
	}

	private visibleEntryRows(): number {
		const rows = this.tui.terminal.rows || 30;
		return Math.max(3, Math.floor(rows * 0.9) - 6);
	}

	private ensureVisible(entryRows = this.visibleEntryRows()): void {
		if (this.selected < this.scroll) this.scroll = this.selected;
		if (this.selected >= this.scroll + entryRows) this.scroll = this.selected - entryRows + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.entries.length - entryRows)));
	}

	private renderEntryRow(
		entry: FileTreeEntry,
		selected: boolean,
		innerW: number,
		row: (content: string) => string,
	): string {
		const th = this.theme;
		const prefix = selected ? th.fg("accent", "›") : " ";
		const icon = this.iconFor(entry);
		const label = this.labelFor(entry);
		let content = ` ${prefix} ${icon} ${label}`;

		if (entry.kind === "dir") content += th.fg("dim", "/");
		if (entry.kind === "symlink") content += ` ${th.fg("dim", "↝")}`;

		content = this.pad(content, innerW);
		if (selected) content = th.bg("selectedBg", content);
		return row(content);
	}

	private iconFor(entry: FileTreeEntry): string {
		const th = this.theme;
		if (entry.kind === "parent") return th.fg("muted", "↰");
		if (entry.kind === "dir") return th.fg("accent", "▸");
		if (entry.kind === "symlink") return th.fg("warning", "◆");
		if (entry.kind === "other") return th.fg("dim", "·");
		return th.fg("dim", "•");
	}

	private labelFor(entry: FileTreeEntry): string {
		const th = this.theme;
		if (entry.kind === "parent") return th.fg("muted", "..");
		if (entry.kind === "dir") return th.fg("text", entry.name);
		if (entry.kind === "file") return th.fg("text", entry.name);
		return th.fg("muted", entry.name);
	}

	private fillRows(count: number, first: string, row: (content: string) => string): string[] {
		const lines = [row(first)];
		while (lines.length < count) lines.push(row(""));
		return lines;
	}

	private pad(content: string, width: number): string {
		return truncateToWidth(content, width, "…", true);
	}

	private relativeCurrentPath(): string {
		const rel = relative(this.basePath, this.currentPath);
		return rel ? rel.split(sep).join("/") : ".";
	}

	private referencePath(filePath: string): string {
		const rel = relative(this.basePath, filePath).split(sep).join("/");
		return rel || cleanName(filePath.split(sep).pop() ?? filePath);
	}

	private isInsideBase(targetPath: string): boolean {
		const rel = relative(this.basePath, targetPath);
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	}
}

function compareEntries(a: FileTreeEntry, b: FileTreeEntry): number {
	if (a.kind === "parent") return -1;
	if (b.kind === "parent") return 1;
	const aDir = a.kind === "dir";
	const bDir = b.kind === "dir";
	if (aDir !== bDir) return aDir ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

function cleanName(name: string): string {
	return name.replace(/[\r\n]/g, " ");
}
