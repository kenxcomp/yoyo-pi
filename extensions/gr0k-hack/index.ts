import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	type AgentToolResult,
	type BashToolDetails,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type FindToolDetails,
	type GrepToolDetails,
	type LsToolDetails,
	type ReadToolDetails,
	type Theme,
	type ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_KEY = "gr0k-hack.agent-status";
const STATE_PATH = resolve(getAgentDir(), "state", "gr0k-hack.json");
const HIDE_DELAY_MS = 1200;
const MAX_CHANGED_FILES = 8;

const agentStatusVariantNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
type AgentStatusVariant = (typeof agentStatusVariantNumbers)[number];
type AgentPhase = "thinking" | "executing" | "reading" | "writing";
type AgentTone = "red" | "yel" | "grn" | "blu" | "pur";
type AgentFillTone = "fred" | "fyel" | "fgrn" | "fblu" | "fdim";

type PersistedGr0kHackState = {
	enabled?: boolean;
	variant?: AgentStatusVariant;
};

type ToolActivity = {
	name: string;
	phase: AgentPhase;
	path?: string;
	startedAt: number;
};

type AgentStatusRuntimeState = {
	enabled: boolean;
	variant: AgentStatusVariant;
	active: boolean;
	phase: AgentPhase;
	latestText: string;
	latestTextSynthetic: boolean;
	lastActivityText?: string;
	currentPath?: string;
	changedFiles: string[];
	activeTools: Map<string, ToolActivity>;
	requestRender?: () => void;
	hideTimer?: ReturnType<typeof setTimeout>;
	renderTicker?: ReturnType<typeof setInterval>;
};

type AgentStatusScenario = {
	label: AgentPhase;
	tone: AgentTone;
	tonefill: AgentFillTone;
	glyph: string;
	thought: string;
	file: string;
};

type TuiPalette = {
	red: string;
	yel: string;
	grn: string;
	blu: string;
	pur: string;
	dim: string;
	faint: string;
	redBg: string;
	yelBg: string;
	grnBg: string;
	bluBg: string;
	dimBg: string;
};

const RENDER_TICK_MS = 90;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DOT_FRAMES = ["   ", ".  ", ".. ", "..."] as const;
const TUI_VARIANT_WIDTH = 86;
const TUI_MICRO_WIDTH = 64;

const TUI_PALETTES: Record<string, TuiPalette> = {
	dark: {
		red: "#D89B7E",
		yel: "#D9B670",
		grn: "#ADC79A",
		blu: "#8FB4CE",
		pur: "#BCA0C5",
		dim: "#B0B0A5",
		faint: "#777768",
		redBg: "#464139",
		yelBg: "#494739",
		grnBg: "#40473D",
		bluBg: "#3A4241",
		dimBg: "#383A36",
	},
	light: {
		red: "#A8734F",
		yel: "#A88A50",
		grn: "#6F8A68",
		blu: "#5F8880",
		pur: "#8A6E9C",
		dim: "#6B6B60",
		faint: "#9A9A8E",
		redBg: "#EDE4DA",
		yelBg: "#EDE7DB",
		grnBg: "#E8E7DD",
		bluBg: "#E6E6DF",
		dimBg: "#E9DDD1",
	},
	paper: {
		red: "#8C2A1F",
		yel: "#8A6A1F",
		grn: "#3F5C45",
		blu: "#2F5A78",
		pur: "#6E4A78",
		dim: "#5B524A",
		faint: "#8C8175",
		redBg: "#E5D4C2",
		yelBg: "#E3D8BE",
		grnBg: "#DAD6C3",
		bluBg: "#DCD9CB",
		dimBg: "#DDC5B3",
	},
};

const agentStatusVariantLabels: Record<AgentStatusVariant, string> = {
	1: "hairline readout",
	2: "phase tag",
	3: "left-rail accent",
	4: "soft card",
	5: "margin labels",
	6: "sigil prefix",
	7: "split-bar",
	8: "micro-log",
	9: "stamp head",
};

let persistedState = loadPersistedState();

const agentStatusState: AgentStatusRuntimeState = {
	enabled: persistedState.enabled !== false,
	variant: isAgentStatusVariant(persistedState.variant) ? persistedState.variant : 1,
	active: false,
	phase: "thinking",
	latestText: "Waiting for model…",
	latestTextSynthetic: true,
	changedFiles: [],
	activeTools: new Map(),
};

export default function gr0kHackExtension(pi: ExtensionAPI) {
	registerCompactBuiltinToolRenderers(pi);
	registerAgentStatusCommand(pi, "switch-agentStatus");

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		applyAgentStatusUI(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		clearHideTimer();
		stopAgentStatusTicker();
		agentStatusState.active = false;
		agentStatusState.activeTools.clear();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
		ctx.ui.setHiddenThinkingLabel();
		agentStatusState.requestRender = undefined;
	});

	pi.on("before_agent_start", () => {
		agentStatusState.lastActivityText = undefined;
		startAgentStatusTurn("thinking");
	});

	pi.on("agent_start", () => {
		startAgentStatusTurn("thinking");
	});

	pi.on("turn_start", () => {
		startAgentStatusTurn("thinking");
	});

	pi.on("message_start", (event) => {
		if (isAssistantMessage(event.message)) {
			setAgentStatusPhase("thinking");
		}
	});

	pi.on("message_update", (event) => {
		if (!isAssistantMessage(event.message)) return;
		const text = extractLatestVisibleAssistantText(event.message);
		if (!text) return;
		if (agentStatusState.activeTools.size === 0) {
			agentStatusState.latestText = text;
			agentStatusState.latestTextSynthetic = false;
			agentStatusState.phase = "thinking";
		}
		activateAgentStatus();
	});

	pi.on("message_end", (event) => {
		if (!isAssistantMessage(event.message)) return;
		const text = extractLatestVisibleAssistantText(event.message);
		if (!text) return;
		agentStatusState.latestText = text;
		agentStatusState.latestTextSynthetic = false;
		requestAgentStatusRender();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const phase = phaseForTool(event.toolName);
		const path = pathForTool(event.toolName, event.args, ctx.cwd);
		const activityText = activityTextForTool(event.toolName, event.args, ctx.cwd);
		if (activityText) agentStatusState.lastActivityText = activityText;
		agentStatusState.activeTools.set(event.toolCallId, {
			name: event.toolName,
			phase,
			path,
			startedAt: Date.now(),
		});
		agentStatusState.phase = phase;
		if (path) agentStatusState.currentPath = path;
		agentStatusState.latestText = activityText ?? syntheticToolText(event.toolName, path);
		agentStatusState.latestTextSynthetic = true;
		activateAgentStatus();
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const existing = agentStatusState.activeTools.get(event.toolCallId);
		if (!existing) return;
		const path = pathForTool(event.toolName, event.args, ctx.cwd) ?? existing.path;
		const activityText = activityTextForTool(event.toolName, event.args, ctx.cwd);
		if (activityText) {
			agentStatusState.lastActivityText = activityText;
			agentStatusState.latestText = activityText;
			agentStatusState.latestTextSynthetic = true;
		}
		existing.path = path;
		if (path) agentStatusState.currentPath = path;
		agentStatusState.phase = existing.phase;
		requestAgentStatusRender();
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		const activityText = activityTextForToolResult(event.toolName, event.input, event.content, ctx.cwd);
		if (activityText) {
			agentStatusState.lastActivityText = activityText;
			agentStatusState.latestText = activityText;
			agentStatusState.latestTextSynthetic = true;
		}
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const path = pathForTool(event.toolName, event.input, ctx.cwd);
		if (path) addChangedFile(path);
	});

	pi.on("tool_execution_end", (event) => {
		const activity = agentStatusState.activeTools.get(event.toolCallId);
		if (activity && !event.isError && (activity.name === "edit" || activity.name === "write") && activity.path) {
			addChangedFile(activity.path);
		}

		agentStatusState.activeTools.delete(event.toolCallId);
		const nextActivity = newestActiveTool();
		if (nextActivity) {
			agentStatusState.phase = nextActivity.phase;
			if (nextActivity.path) agentStatusState.currentPath = nextActivity.path;
		} else {
			agentStatusState.phase = "thinking";
			if (activity?.path) agentStatusState.currentPath = activity.path;
			if (agentStatusState.latestTextSynthetic) {
				agentStatusState.latestText = event.isError
					? `${activity?.name ?? event.toolName} failed`
					: (agentStatusState.lastActivityText ?? `${activity?.name ?? event.toolName} complete`);
			}
		}
		activateAgentStatus();
	});

	pi.on("agent_end", () => {
		agentStatusState.activeTools.clear();
		if (agentStatusState.changedFiles.length > 0) {
			agentStatusState.currentPath = agentStatusState.changedFiles[agentStatusState.changedFiles.length - 1];
		}
		if (agentStatusState.latestTextSynthetic) agentStatusState.latestText = "Done";
		agentStatusState.phase = "thinking";
		requestAgentStatusRender();
		scheduleHideAgentStatus();
	});
}

function registerAgentStatusCommand(pi: ExtensionAPI, name: "switch-agentStatus"): void {
	pi.registerCommand(name, {
		description: "Switch gr0k-hack agent status UI (1-9). Use 0/off to restore pi's default loader.",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				...agentStatusVariantNumbers.map((variant) => ({
					value: String(variant),
					label: String(variant),
					description: agentStatusVariantLabels[variant],
				})),
				{ value: "status", label: "status", description: "show the current gr0k-hack agent status setting" },
				{ value: "0", label: "0", description: "turn off the custom agent status widget" },
			];
			const completions = items.filter((item) => item.value.startsWith(p) || item.description.toLowerCase().includes(p));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) return;

			const parsed = parseAgentStatusArg(args);
			if (parsed === "status") {
				ctx.ui.notify(
					`Agent status: ${agentStatusState.enabled ? "on" : "off"}, variant ${agentStatusState.variant} (${agentStatusVariantLabels[agentStatusState.variant]})`,
					"info",
				);
				return;
			}
			if (parsed === undefined) {
				ctx.ui.notify("Usage: /switch-agentStatus <1-9|v1-v9|0|off|status>", "warning");
				return;
			}

			if (parsed === 0) {
				agentStatusState.enabled = false;
				persistAgentStatusState({ enabled: false, variant: agentStatusState.variant });
				applyAgentStatusUI(ctx);
				ctx.ui.notify("Agent status: default pi loader (persisted)", "info");
				return;
			}

			agentStatusState.enabled = true;
			agentStatusState.variant = parsed;
			persistAgentStatusState({ enabled: true, variant: parsed });
			applyAgentStatusUI(ctx);
			ctx.ui.notify(`Agent status ${parsed}: ${agentStatusVariantLabels[parsed]} (persisted)`, "info");
		},
	});
}

function parseAgentStatusArg(args: string): AgentStatusVariant | 0 | "status" | undefined {
	const value = args.trim().toLowerCase();
	if (!value || value === "status") return "status";
	if (["0", "off", "default", "reset", "false", "disable", "disabled"].includes(value)) return 0;
	const normalized = value.startsWith("v") ? value.slice(1) : value;
	if (!/^\d+$/.test(normalized)) return undefined;
	const numeric = Number.parseInt(normalized, 10);
	return isAgentStatusVariant(numeric) ? numeric : undefined;
}

function isAgentStatusVariant(value: unknown): value is AgentStatusVariant {
	return typeof value === "number" && (agentStatusVariantNumbers as readonly number[]).includes(value);
}

function applyAgentStatusUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	if (!agentStatusState.enabled) {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
		ctx.ui.setHiddenThinkingLabel();
		stopAgentStatusTicker();
		return;
	}

	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWorkingIndicator({ frames: [] });
	ctx.ui.setHiddenThinkingLabel("");
	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => new AgentStatusWidget(tui, theme, agentStatusState), {
		placement: "aboveEditor",
	});
	requestAgentStatusRender();
}

class AgentStatusWidget implements Component {
	private readonly requestRender: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly state: AgentStatusRuntimeState,
	) {
		this.requestRender = () => this.tui.requestRender();
		this.state.requestRender = this.requestRender;
	}

	render(width: number): string[] {
		if (!this.state.enabled || !this.state.active) return [];
		const w = Math.max(1, width);
		const lines = renderAgentStatusLines(this.state, this.theme, w);
		return lines.map((line) => fitLine(line, w));
	}

	invalidate(): void {}

	dispose(): void {
		if (this.state.requestRender === this.requestRender) this.state.requestRender = undefined;
	}
}

function renderAgentStatusLines(state: AgentStatusRuntimeState, theme: Theme, _width: number): string[] {
	const scenario = scenarioForState(state);
	const markupLines = buildAgentStatusVariant(state.variant, scenario);
	return markupLines.map((line) => renderTuiMarkup(line, theme));
}

function scenarioForState(state: AgentStatusRuntimeState): AgentStatusScenario {
	const thought = cleanInline(state.latestText) || "Waiting for model…";
	const file = displayPath(state);

	switch (state.phase) {
		case "executing":
			return { label: "executing", tone: "red", tonefill: "fred", glyph: "▶", thought, file };
		case "reading":
			return { label: "reading", tone: "blu", tonefill: "fblu", glyph: "◐", thought, file };
		case "writing":
			return { label: "writing", tone: "grn", tonefill: "fgrn", glyph: "✎", thought, file };
		case "thinking":
		default:
			return { label: "thinking", tone: "yel", tonefill: "fyel", glyph: "✱", thought, file };
	}
}

function buildAgentStatusVariant(variant: AgentStatusVariant, scn: AgentStatusScenario): string[] {
	switch (variant) {
		case 2:
			return v2Step(scn);
		case 3:
			return v3Rail(scn);
		case 4:
			return v4Card(scn);
		case 5:
			return v5Margin(scn);
		case 6:
			return v6Sigil(scn);
		case 7:
			return v7Split(scn);
		case 8:
			return v8Micro(scn);
		case 9:
			return v9Stamp(scn);
		case 1:
		default:
			return v1Hairline(scn);
	}
}

function v1Hairline(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	const badge = `«${scn.tonefill}» ${scn.label.toUpperCase()} «/»`;
	return [
		" " + badge + "   «spin» «" + scn.tone + "»" + scn.glyph + "«/»  «faint»" + new Date().toLocaleTimeString([], { hour12: false }) + "«/»",
		" «dim»" + tuiPad(scn.thought + "«dots»", W - 2) + "«/»",
		" «faint»↳«/»  «" + scn.tone + "»" + truncStart(scn.file, W - 6) + "«/»",
	];
}

function v2Step(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	return [
		" «faint»[agent] «/»«" + scn.tone + "»" + scn.label.toUpperCase() + "«/»«dots»",
		" «dim»❝ " + scn.thought + " ❞«/»",
		" «faint»file «/»«" + scn.tone + "»" + truncStart(scn.file, W - 8) + "«/»",
	];
}

function v3Rail(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	return [
		"«" + scn.tone + "»▌«/» «b»" + scn.label.toUpperCase() + "«/»  «spin» «faint»agent · turn 7«/»",
		"«" + scn.tone + "»▌«/» «dim»" + scn.thought + "«/»«dots»",
		"«" + scn.tone + "»▌«/» «faint»↳«/» «" + scn.tone + "»" + truncStart(scn.file, W - 6) + "«/»",
	];
}

function v4Card(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	const inner = W - 2;
	const head = " «spin»  «b»" + scn.label.toUpperCase() + "«/»«dots»" + "  «faint»·  agent · turn 7«/»";
	const mid = " «dim»" + scn.thought + "«/»";
	const foot = " «faint»↳«/» «" + scn.tone + "»" + truncStart(scn.file, inner - 4) + "«/»";
	return [
		"╭" + "─".repeat(W - 2) + "╮",
		"│" + tuiPad(head, inner) + "│",
		"├" + "┄".repeat(W - 2) + "┤",
		"│" + tuiPad(mid, inner) + "│",
		"│" + tuiPad(foot, inner) + "│",
		"╰" + "─".repeat(W - 2) + "╯",
	];
}

function v5Margin(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	const G = 12;
	const m = (value: string) => tuiPad(value, G);
	return [
		m("«faint»state«/»") + "«" + scn.tonefill + "» " + scn.label.toUpperCase() + " «/»" + "   «spin»  «faint»turn 7«/»",
		m("«faint»thought«/»") + "«dim»" + scn.thought + "«/»«dots»",
		m("«faint»file«/»") + "«" + scn.tone + "»" + truncStart(scn.file, W - G) + "«/»",
	];
}

function v6Sigil(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	return [
		"«faint»::«/» «" + scn.tone + "»" + scn.label + "«/»«dots»" + "   «faint»turn 7 · 1.4s«/»",
		"«faint» ›«/» «dim»" + scn.thought + "«/»",
		"«faint» ⌁«/» «" + scn.tone + "»" + truncStart(scn.file, W - 6) + "«/»",
	];
}

function v7Split(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	const topTab = `╴ «${scn.tonefill}» ${scn.label.toUpperCase()} «/» «faint»turn 7«/» ╴`;
	const topPad = W - tuiLen(topTab);
	const file = truncStart(scn.file, W - 14);
	const botTab = `«faint»╴«/» «faint»file«/» «${scn.tone}»${file}«/» «faint»╴«/»`;
	const botPad = W - tuiLen(botTab);
	return [
		topTab + "«faint»" + "─".repeat(Math.max(2, topPad)) + "«/»",
		"",
		" «spin»  «dim»" + scn.thought + "«/»«dots»",
		"",
		botTab + "«faint»" + "─".repeat(Math.max(2, botPad)) + "«/»",
	];
}

function v8Micro(scn: AgentStatusScenario): string[] {
	const W = TUI_MICRO_WIDTH;
	return [
		"«" + scn.tone + "»●«/» «b»" + scn.label + "«/»" + "«dots»",
		"«faint»│«/»  «dim»" + scn.thought + "«/»",
		"«faint»╰─«/»«faint»file «/»«" + scn.tone + "»" + truncStart(scn.file, W - 12) + "«/»",
	];
}

function v9Stamp(scn: AgentStatusScenario): string[] {
	const W = TUI_VARIANT_WIDTH;
	return [
		"«" + scn.tonefill + "» " + scn.label.toUpperCase().padEnd(9, " ") + "«/» «spin»  «dim»" + scn.thought + "«/»«dots»",
		" ".repeat(11) + "«faint»" + "─".repeat(W - 12) + "«/»",
		" ".repeat(11) + "«faint»↳ file«/»  «" + scn.tone + "»" + truncStart(scn.file, W - 22) + "«/»",
	];
}

function renderTuiMarkup(line: string, theme: Theme): string {
	const out: string[] = [];
	const stack: string[] = [];
	let buf = "";
	let i = 0;
	const flush = () => {
		if (!buf) return;
		out.push(applyTuiTokens(buf, stack, theme));
		buf = "";
	};

	while (i < line.length) {
		if (line[i] === "«" && line.charAt(i + 1) === "/" && line.charAt(i + 2) === "»") {
			flush();
			stack.pop();
			i += 3;
		} else if (line[i] === "«") {
			const close = line.indexOf("»", i + 1);
			if (close === -1) {
				buf += line[i];
				i++;
				continue;
			}
			flush();
			const tok = line.slice(i + 1, close);
			if (tok === "spin") {
				out.push(currentSpinnerFrame());
			} else if (tok === "dots") {
				out.push(currentDotFrame());
			} else if (tok === "pulse") {
				out.push("      ");
			} else {
				stack.push(tok);
			}
			i = close + 1;
		} else {
			buf += line[i];
			i++;
		}
	}
	flush();
	return out.join("");
}

function applyTuiTokens(text: string, tokens: readonly string[], theme: Theme): string {
	let styled = text;
	let fgToken: AgentTone | "dim" | "faint" | undefined;
	let fillToken: AgentFillTone | undefined;
	let bold = false;
	let italic = false;

	for (const token of tokens) {
		switch (token) {
			case "red":
			case "yel":
			case "grn":
			case "blu":
			case "pur":
			case "dim":
			case "faint":
				fgToken = token;
				break;
			case "fred":
			case "fyel":
			case "fgrn":
			case "fblu":
			case "fdim":
				fillToken = token;
				break;
			case "b":
				bold = true;
				break;
			case "it":
				italic = true;
				break;
		}
	}

	if (bold) styled = theme.bold(styled);
	if (italic) styled = theme.italic(styled);
	if (fgToken) styled = applyTuiFg(theme, fgToken, styled);
	if (fillToken) styled = applyTuiFill(theme, fillToken, styled);
	return styled;
}

function applyTuiFg(theme: Theme, token: AgentTone | "dim" | "faint", text: string): string {
	const palette = paletteForTheme(theme);
	if (palette) return ansiFg(palette[token], text);

	switch (token) {
		case "red":
			return theme.fg("accent", text);
		case "yel":
			return theme.fg("warning", text);
		case "grn":
			return theme.fg("success", text);
		case "blu":
			return theme.fg("mdLink", text);
		case "pur":
			return theme.fg("syntaxNumber", text);
		case "dim":
			return theme.fg("muted", text);
		case "faint":
		default:
			return theme.fg("dim", text);
	}
}

function applyTuiFill(theme: Theme, token: AgentFillTone, text: string): string {
	const palette = paletteForTheme(theme);
	if (palette) {
		const colorToken = fillToColorToken(token);
		const fg = colorToken ? ansiFg(palette[colorToken], text) : text;
		return ansiBg(palette[fillToBgKey(token)], fg);
	}

	switch (token) {
		case "fred":
			return theme.bg("toolErrorBg", theme.fg("accent", text));
		case "fyel":
			return theme.bg("selectedBg", theme.fg("warning", text));
		case "fgrn":
			return theme.bg("toolSuccessBg", theme.fg("success", text));
		case "fblu":
			return theme.bg("toolPendingBg", theme.fg("mdLink", text));
		case "fdim":
		default:
			return theme.bg("selectedBg", text);
	}
}

function fillToColorToken(token: AgentFillTone): AgentTone | undefined {
	switch (token) {
		case "fred":
			return "red";
		case "fyel":
			return "yel";
		case "fgrn":
			return "grn";
		case "fblu":
			return "blu";
		case "fdim":
		default:
			return undefined;
	}
}

function fillToBgKey(token: AgentFillTone): keyof TuiPalette {
	switch (token) {
		case "fred":
			return "redBg";
		case "fyel":
			return "yelBg";
		case "fgrn":
			return "grnBg";
		case "fblu":
			return "bluBg";
		case "fdim":
		default:
			return "dimBg";
	}
}

function paletteForTheme(theme: Theme): TuiPalette | undefined {
	const key = (theme.name ?? "").toLowerCase();
	return TUI_PALETTES[key];
}

function ansiFg(hex: string, text: string): string {
	const rgb = hexToRgb(hex);
	return rgb ? `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[39m` : text;
}

function ansiBg(hex: string, text: string): string {
	const rgb = hexToRgb(hex);
	return rgb ? `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[49m` : text;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | undefined {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return undefined;
	const value = Number.parseInt(match[1], 16);
	return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function currentSpinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / RENDER_TICK_MS) % SPINNER_FRAMES.length];
}

function currentDotFrame(): string {
	return DOT_FRAMES[Math.floor(Date.now() / 350) % DOT_FRAMES.length];
}

function tuiLen(line: string): number {
	return line.replace(/«spin»|«dots»|«pulse»/g, " ").replace(/«[^»]*»/g, "").length;
}

function tuiPad(line: string, width: number, fill = " "): string {
	const n = tuiLen(line);
	if (n >= width) return line;
	return line + fill.repeat(width - n);
}

function truncStart(value: string, width: number): string {
	if (width <= 0) return "";
	const s = cleanInline(value);
	if (s.length <= width) return s;
	if (width === 1) return "…";
	return "…" + s.slice(s.length - width + 1);
}

function fitLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…", false);
}

function displayPath(state: AgentStatusRuntimeState): string {
	const latestChanged = state.changedFiles[state.changedFiles.length - 1];
	return state.currentPath ?? latestChanged ?? "no file yet";
}

function startAgentStatusTurn(phase: AgentPhase): void {
	clearHideTimer();
	startAgentStatusTicker();
	agentStatusState.active = true;
	agentStatusState.phase = phase;
	agentStatusState.latestText = agentStatusState.lastActivityText ?? "Waiting for next model output…";
	agentStatusState.latestTextSynthetic = true;
	agentStatusState.currentPath = agentStatusState.changedFiles[agentStatusState.changedFiles.length - 1];
	requestAgentStatusRender();
}

function setAgentStatusPhase(phase: AgentPhase): void {
	clearHideTimer();
	startAgentStatusTicker();
	agentStatusState.active = true;
	agentStatusState.phase = phase;
	requestAgentStatusRender();
}

function activateAgentStatus(): void {
	clearHideTimer();
	startAgentStatusTicker();
	agentStatusState.active = true;
	requestAgentStatusRender();
}

function scheduleHideAgentStatus(): void {
	clearHideTimer();
	agentStatusState.hideTimer = setTimeout(() => {
		agentStatusState.hideTimer = undefined;
		agentStatusState.active = false;
		requestAgentStatusRender();
		stopAgentStatusTicker();
	}, HIDE_DELAY_MS);
}

function clearHideTimer(): void {
	if (!agentStatusState.hideTimer) return;
	clearTimeout(agentStatusState.hideTimer);
	agentStatusState.hideTimer = undefined;
}

function requestAgentStatusRender(): void {
	if (!agentStatusState.enabled) return;
	agentStatusState.requestRender?.();
}

function startAgentStatusTicker(): void {
	if (!agentStatusState.enabled || agentStatusState.renderTicker) return;
	agentStatusState.renderTicker = setInterval(requestAgentStatusRender, RENDER_TICK_MS);
}

function stopAgentStatusTicker(): void {
	if (!agentStatusState.renderTicker) return;
	clearInterval(agentStatusState.renderTicker);
	agentStatusState.renderTicker = undefined;
}

function newestActiveTool(): ToolActivity | undefined {
	let newest: ToolActivity | undefined;
	for (const activity of agentStatusState.activeTools.values()) {
		if (!newest || activity.startedAt >= newest.startedAt) newest = activity;
	}
	return newest;
}

function addChangedFile(filePath: string): void {
	const compact = cleanInline(filePath);
	if (!compact) return;
	agentStatusState.changedFiles = agentStatusState.changedFiles.filter((item) => item !== compact);
	agentStatusState.changedFiles.push(compact);
	if (agentStatusState.changedFiles.length > MAX_CHANGED_FILES) {
		agentStatusState.changedFiles = agentStatusState.changedFiles.slice(-MAX_CHANGED_FILES);
	}
	agentStatusState.currentPath = compact;
	requestAgentStatusRender();
}

function phaseForTool(toolName: string): AgentPhase {
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") return "reading";
	if (toolName === "edit" || toolName === "write") return "writing";
	return "executing";
}

function syntheticToolText(toolName: string, path?: string): string {
	const target = path ? ` ${path}` : "";
	switch (phaseForTool(toolName)) {
		case "reading":
			return `reading${target}`;
		case "writing":
			return `${toolName === "write" ? "writing" : "editing"}${target}`;
		case "executing":
			return `${toolName}${target}`;
		case "thinking":
		default:
			return "Waiting for model output…";
	}
}

function activityTextForTool(toolName: string, args: unknown, cwd: string): string | undefined {
	const path = pathForTool(toolName, args, cwd);
	const subject = path ? ` ${path}` : "";
	const suffix = activitySuffixForToolInput(toolName, args);
	return `${toolName.toUpperCase()}${subject}${suffix ? `  ${suffix}` : ""}`;
}

function activityTextForToolResult(toolName: string, input: unknown, content: unknown, cwd: string): string | undefined {
	const path = pathForTool(toolName, input, cwd);
	const subject = path ? ` ${path}` : "";
	const suffix = activitySuffixForToolResult(toolName, input, content) ?? activitySuffixForToolInput(toolName, input);
	return `${toolName.toUpperCase()}${subject}${suffix ? `  ${suffix}` : ""}`;
}

function activitySuffixForToolInput(toolName: string, input: unknown): string | undefined {
	const record = isRecord(input) ? input : {};
	switch (toolName) {
		case "write": {
			const content = typeof record.content === "string" ? record.content : "";
			return `${lineCount(content)} lines`;
		}
		case "edit": {
			const count = Array.isArray(record.edits) ? record.edits.length : 0;
			return count > 0 ? `${count} replacements` : undefined;
		}
		case "grep": {
			const pattern = typeof record.pattern === "string" ? cleanInline(record.pattern) : "";
			return pattern ? `/${truncateToWidth(pattern, 64, "…")}/` : undefined;
		}
		case "find": {
			const pattern = typeof record.pattern === "string" ? cleanInline(record.pattern) : "";
			return pattern || undefined;
		}
		case "read": {
			const parts = [typeof record.offset === "number" ? `offset=${record.offset}` : undefined, typeof record.limit === "number" ? `limit=${record.limit}` : undefined].filter(Boolean);
			return parts.join(", ") || undefined;
		}
		case "bash": {
			const timeout = typeof record.timeout === "number" ? `timeout=${record.timeout}s` : "";
			return timeout || undefined;
		}
		default:
			return undefined;
	}
}

function activitySuffixForToolResult(toolName: string, input: unknown, content: unknown): string | undefined {
	switch (toolName) {
		case "read":
			return `${lineCount(firstTextFromContent(content))} lines`;
		case "grep":
			return `${lineCount(firstTextFromContent(content))} matching lines`;
		case "find":
			return `${lineCount(firstTextFromContent(content))} paths`;
		case "ls":
			return `${lineCount(firstTextFromContent(content))} entries`;
		case "bash":
			return `${lineCount(firstTextFromContent(content))} output lines`;
		case "write":
		case "edit":
			return activitySuffixForToolInput(toolName, input);
		default:
			return undefined;
	}
}

function firstTextFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const first = content[0];
	return isRecord(first) && first.type === "text" && typeof first.text === "string" ? first.text : "";
}

function pathForTool(toolName: string, args: unknown, cwd: string): string | undefined {
	const record = isRecord(args) ? args : {};
	const rawPath = typeof record.path === "string" ? record.path : undefined;
	if (rawPath) return compactPath(rawPath, cwd);
	if (toolName === "grep" && typeof record.glob === "string" && record.glob) return record.glob;
	if (toolName === "find" && typeof record.pattern === "string" && record.pattern) return record.pattern;
	if (toolName === "ls") return compactPath(".", cwd);
	if (toolName === "bash" && typeof record.command === "string" && record.command) return `$ ${cleanInline(record.command)}`;
	return undefined;
}

function compactPath(input: string, cwd = process.cwd()): string {
	const trimmed = input.trim().replace(/^@/, "");
	if (!trimmed) return trimmed;
	if (trimmed === ".") return ".";
	try {
		const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
		const rel = relative(cwd, absolute);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
		return trimmed;
	} catch {
		return trimmed;
	}
}

function extractLatestVisibleAssistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	const content = Array.isArray(message.content) ? message.content : [];
	const chunks: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		chunks.push(block.text);
	}
	return latestNonEmptyLine(chunks.join(""));
}

function latestNonEmptyLine(value: string): string {
	const lines = value.replace(/\r/g, "").split("\n").map(cleanInline).filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

function cleanInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isAssistantMessage(message: unknown): boolean {
	return isRecord(message) && message.role === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function loadPersistedState(): PersistedGr0kHackState {
	try {
		const raw = readFileSync(STATE_PATH, "utf-8");
		const parsed = JSON.parse(raw) as PersistedGr0kHackState;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function persistAgentStatusState(patch: PersistedGr0kHackState): void {
	persistedState = {
		...persistedState,
		...patch,
	};
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(persistedState, null, "\t") + "\n");
	} catch {
		// Preference persistence should never break the agent loop.
	}
}

function registerCompactBuiltinToolRenderers(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	const read = createReadToolDefinition(cwd);
	pi.registerTool({
		...read,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const record = isRecord(args) ? args : {};
			const path = typeof record.path === "string" ? compactPath(record.path, context.cwd) : "file";
			const parts = [typeof record.offset === "number" ? `offset=${record.offset}` : undefined, typeof record.limit === "number" ? `limit=${record.limit}` : undefined].filter(Boolean);
			return compactToolText(theme, "READING", path, parts.join(", "));
		},
		renderResult: (result: AgentToolResult<ReadToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "READING", "in progress…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const first = result.content[0];
			if (first?.type === "image") return compactToolText(theme, "READ", "image loaded");
			const content = first?.type === "text" ? first.text : "";
			const details = result.details;
			const totalLines = details?.truncation?.totalLines ?? lineCount(content);
			const suffix = details?.truncation?.truncated ? `truncated • ${totalLines} lines total` : `${totalLines} lines`;
			return compactToolText(theme, "READ", pathFromContext(context, "read"), suffix, "success");
		},
	});

	const grep = createGrepToolDefinition(cwd);
	pi.registerTool({
		...grep,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const record = isRecord(args) ? args : {};
			const pattern = typeof record.pattern === "string" ? record.pattern : "pattern";
			const path = pathForTool("grep", args, context.cwd) ?? ".";
			return compactToolText(theme, "SEARCH", path, `/${cleanInline(pattern)}/`);
		},
		renderResult: (result: AgentToolResult<GrepToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "SEARCH", "in progress…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const content = firstText(result);
			const details = result.details;
			const matches = lineCount(content);
			const suffix = [
				`${matches} matching lines`,
				details?.matchLimitReached ? `limit ${details.matchLimitReached}` : undefined,
				details?.truncation?.truncated || details?.linesTruncated ? "truncated" : undefined,
			]
				.filter(Boolean)
				.join(" • ");
			return compactToolText(theme, "SEARCH", pathFromContext(context, "grep"), suffix, "success");
		},
	});

	const find = createFindToolDefinition(cwd);
	pi.registerTool({
		...find,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const record = isRecord(args) ? args : {};
			const path = pathForTool("find", args, context.cwd) ?? ".";
			const pattern = typeof record.pattern === "string" ? record.pattern : "*";
			return compactToolText(theme, "FIND", path, pattern);
		},
		renderResult: (result: AgentToolResult<FindToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "FIND", "in progress…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const details = result.details;
			const suffix = [`${lineCount(firstText(result))} paths`, details?.resultLimitReached ? `limit ${details.resultLimitReached}` : undefined, details?.truncation?.truncated ? "truncated" : undefined]
				.filter(Boolean)
				.join(" • ");
			return compactToolText(theme, "FIND", pathFromContext(context, "find"), suffix, "success");
		},
	});

	const ls = createLsToolDefinition(cwd);
	pi.registerTool({
		...ls,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const path = pathForTool("ls", args, context.cwd) ?? ".";
			return compactToolText(theme, "LIST", path);
		},
		renderResult: (result: AgentToolResult<LsToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "LIST", "in progress…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const details = result.details;
			const suffix = [`${lineCount(firstText(result))} entries`, details?.entryLimitReached ? `limit ${details.entryLimitReached}` : undefined, details?.truncation?.truncated ? "truncated" : undefined]
				.filter(Boolean)
				.join(" • ");
			return compactToolText(theme, "LIST", pathFromContext(context, "ls"), suffix, "success");
		},
	});

	const bash = createBashToolDefinition(cwd);
	pi.registerTool({
		...bash,
		renderCall: (args: unknown, theme: Theme) => {
			const record = isRecord(args) ? args : {};
			const command = typeof record.command === "string" ? cleanInline(record.command) : "shell";
			const timeout = typeof record.timeout === "number" ? `timeout=${record.timeout}s` : "";
			return compactToolText(theme, "EXEC", `$ ${command}`, timeout);
		},
		renderResult: (result: AgentToolResult<BashToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "EXEC", "running…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const content = firstText(result);
			const details = result.details;
			const suffix = [`${lineCount(content)} output lines`, details?.truncation?.truncated ? "truncated" : undefined, details?.fullOutputPath ? `full log ${compactPath(details.fullOutputPath, context.cwd)}` : undefined]
				.filter(Boolean)
				.join(" • ");
			return compactToolText(theme, "EXEC", "complete", suffix, "success");
		},
	});

	const edit = createEditToolDefinition(cwd);
	pi.registerTool({
		...edit,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const record = isRecord(args) ? args : {};
			const path = typeof record.path === "string" ? compactPath(record.path, context.cwd) : "file";
			const editCount = Array.isArray(record.edits) ? record.edits.length : 0;
			return compactToolText(theme, "EDIT", path, `${editCount} replacements`);
		},
		renderResult: (result: AgentToolResult<EditToolDetails | undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "EDIT", "applying…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			const stats = editStats(result.details);
			const suffix = stats ? `${stats.added} added • ${stats.removed} removed • diff hidden` : "applied • diff hidden";
			return compactToolText(theme, "EDIT", pathFromContext(context, "edit"), suffix, "success");
		},
	});

	const write = createWriteToolDefinition(cwd);
	pi.registerTool({
		...write,
		renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
			const record = isRecord(args) ? args : {};
			const path = typeof record.path === "string" ? compactPath(record.path, context.cwd) : "file";
			const content = typeof record.content === "string" ? record.content : "";
			return compactToolText(theme, "WRITE", path, `${lineCount(content)} lines • content hidden`);
		},
		renderResult: (result: AgentToolResult<undefined>, _options, theme: Theme, context) => {
			if (context.isPartial) return compactToolText(theme, "WRITE", "saving…");
			const error = compactError(result, context, theme);
			if (error) return new Text(error, 0, 0);
			return compactToolText(theme, "WRITE", pathFromContext(context, "write"), "written • content hidden", "success");
		},
	});
}

function compactToolText(theme: Theme, label: string, subject: string, suffix = "", mode: "active" | "success" = "active"): Text {
	const color = mode === "success" ? "success" : label === "READING" || label === "SEARCH" || label === "FIND" || label === "LIST" ? "mdLink" : "warning";
	let text = `${theme.fg(color, theme.bold(label))} ${theme.fg("accent", truncateToWidth(cleanInline(subject), 96, "…"))}`;
	if (suffix) text += theme.fg("dim", `  ${truncateToWidth(cleanInline(suffix), 96, "…")}`);
	return new Text(text, 0, 0);
}

function compactError(result: AgentToolResult<unknown>, context: ToolRenderContext, theme: Theme): string | undefined {
	if (!context.isError) return undefined;
	const first = latestNonEmptyLine(firstText(result)) || "tool failed";
	return `${theme.fg("error", theme.bold("ERROR"))} ${theme.fg("dim", truncateToWidth(first, 120, "…"))}`;
}

function pathFromContext(context: ToolRenderContext, toolName: string): string {
	const args = isRecord(context.args) ? context.args : {};
	const path = typeof args.path === "string" ? compactPath(args.path, context.cwd) : undefined;
	if (path) return path;
	return pathForTool(toolName, context.args, context.cwd) ?? "done";
}

function firstText(result: AgentToolResult<unknown>): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text : "";
}

function lineCount(value: string): number {
	if (!value) return 0;
	const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
	if (!normalized) return 0;
	return normalized.split(/\r?\n/).length;
}

function editStats(details: EditToolDetails | undefined): { added: number; removed: number } | undefined {
	const diff = details?.diff ?? details?.patch;
	if (!diff) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}
