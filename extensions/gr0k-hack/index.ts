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

const agentStatusVariantNumbers = [1, 2, 3, 4] as const;
type AgentStatusVariant = (typeof agentStatusVariantNumbers)[number];
type AgentPhase = "thinking" | "executing" | "reading";

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
	currentPath?: string;
	changedFiles: string[];
	activeTools: Map<string, ToolActivity>;
	requestRender?: () => void;
	hideTimer?: ReturnType<typeof setTimeout>;
};

const agentStatusVariantLabels: Record<AgentStatusVariant, string> = {
	1: "Grok web rail",
	2: "thin terminal frame",
	3: "soft status chips",
	4: "blueprint pulse",
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
		agentStatusState.active = false;
		agentStatusState.activeTools.clear();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingVisible(true);
		ctx.ui.setWorkingIndicator();
		ctx.ui.setWorkingMessage();
		agentStatusState.requestRender = undefined;
	});

	pi.on("before_agent_start", () => {
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
		agentStatusState.latestText = text;
		agentStatusState.latestTextSynthetic = false;
		if (agentStatusState.activeTools.size === 0) agentStatusState.phase = "thinking";
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
		agentStatusState.activeTools.set(event.toolCallId, {
			name: event.toolName,
			phase,
			path,
			startedAt: Date.now(),
		});
		agentStatusState.phase = phase;
		if (path) agentStatusState.currentPath = path;
		if (!agentStatusState.latestText || agentStatusState.latestTextSynthetic) {
			agentStatusState.latestText = syntheticToolText(event.toolName, path);
			agentStatusState.latestTextSynthetic = true;
		}
		activateAgentStatus();
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const existing = agentStatusState.activeTools.get(event.toolCallId);
		if (!existing) return;
		const path = pathForTool(event.toolName, event.args, ctx.cwd) ?? existing.path;
		existing.path = path;
		if (path) agentStatusState.currentPath = path;
		agentStatusState.phase = existing.phase;
		requestAgentStatusRender();
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
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
					: `${activity?.name ?? event.toolName} complete`;
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
		description: "Switch gr0k-hack three-line agent status UI (1-4). Use 0/off to restore pi's default loader.",
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
				ctx.ui.notify("Usage: /switch-agentStatus <1-4|0|off|status>", "warning");
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
	const numeric = Number.parseInt(value, 10);
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
		return;
	}

	ctx.ui.setWorkingVisible(false);
	ctx.ui.setWorkingIndicator({ frames: [] });
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
		return [0, 1, 2].map((index) => fitLine(lines[index] ?? "", w));
	}

	invalidate(): void {}

	dispose(): void {
		if (this.state.requestRender === this.requestRender) this.state.requestRender = undefined;
	}
}

function renderAgentStatusLines(state: AgentStatusRuntimeState, theme: Theme, _width: number): string[] {
	const phaseLabel = state.phase.toUpperCase();
	const prompt = cleanInline(state.latestText) || "Waiting for model…";
	const path = displayPath(state);
	const phase = colorPhase(theme, state.phase, phaseLabel);
	const dimPrompt = theme.fg("muted", prompt);
	const file = theme.fg("mdLink", path);
	const accentFile = theme.fg("accent", path);
	const faint = (value: string) => theme.fg("dim", value);
	const variant = isAgentStatusVariant(state.variant) ? state.variant : 1;

	switch (variant) {
		case 2:
			return [
				`${faint("╭─")} ${phase}`,
				`${faint("│ ")}${dimPrompt}`,
				`${faint("╰─↳ ")}${file}`,
			];
		case 3:
			return [
				`${theme.fg("borderMuted", "[")} ${phase} ${theme.fg("borderMuted", "]")}`,
				`${theme.fg("accent", "›")} ${dimPrompt}`,
				`${theme.fg("mdLink", "↳")} ${accentFile}`,
			];
		case 4: {
			const rail = theme.fg("mdLink", "▌");
			return [
				`${rail} ${phase}`,
				`${rail} ${theme.fg("thinkingText", prompt)}`,
				`${rail} ${theme.fg("mdLink", "↳")} ${file}`,
			];
		}
		case 1:
		default:
			return [
				`${theme.fg("warning", "●")} ${phase}`,
				`  ${dimPrompt}`,
				`  ${theme.fg("mdLink", "↳")} ${file}`,
			];
	}
}

function colorPhase(theme: Theme, phase: AgentPhase, label: string): string {
	const bold = theme.bold(label);
	switch (phase) {
		case "reading":
			return theme.fg("mdLink", bold);
		case "executing":
			return theme.fg("success", bold);
		case "thinking":
		default:
			return theme.fg("warning", bold);
	}
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
	agentStatusState.active = true;
	agentStatusState.phase = phase;
	agentStatusState.latestText = "Thinking…";
	agentStatusState.latestTextSynthetic = true;
	agentStatusState.currentPath = agentStatusState.changedFiles[agentStatusState.changedFiles.length - 1];
	requestAgentStatusRender();
}

function setAgentStatusPhase(phase: AgentPhase): void {
	clearHideTimer();
	agentStatusState.active = true;
	agentStatusState.phase = phase;
	requestAgentStatusRender();
}

function activateAgentStatus(): void {
	clearHideTimer();
	agentStatusState.active = true;
	requestAgentStatusRender();
}

function scheduleHideAgentStatus(): void {
	clearHideTimer();
	agentStatusState.hideTimer = setTimeout(() => {
		agentStatusState.hideTimer = undefined;
		agentStatusState.active = false;
		requestAgentStatusRender();
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
	return "executing";
}

function syntheticToolText(toolName: string, path?: string): string {
	const target = path ? ` ${path}` : "";
	switch (phaseForTool(toolName)) {
		case "reading":
			return `reading${target}`;
		case "executing":
			return `${toolName}${target}`;
		case "thinking":
		default:
			return "Thinking…";
	}
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
