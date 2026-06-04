import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverQaAgents, formatQaAgentList, type QaAgentConfig, type QaAgentScope, type QaAgentSource } from "./qa-agents.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const GR0K_HACK_EXTENSION_PATH = path.join(EXTENSION_DIR, "index.ts");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_STDERR_CHARS = 20_000;
const COLLAPSED_ITEM_COUNT = 8;

type Message = {
	role?: string;
	content?: Array<Record<string, any>> | string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: any;
};

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

type SingleResult = {
	agent: string;
	agentSource: QaAgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
};

type SubagentMode = "single" | "parallel" | "chain";

type SubagentDetails = {
	mode: SubagentMode;
	agentScope: QaAgentScope;
	bundledAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	results: SingleResult[];
};

type ToolResultPatch = {
	content: Array<{ type: "text"; text: string }>;
	details?: SubagentDetails;
	isError?: boolean;
};

type OnUpdateCallback = (partial: ToolResultPatch) => void;

type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `[... truncated ${text.length - maxChars} characters ...]\n${text.slice(-maxChars)}`;
}

function truncateByBytes(text: string, maxBytes: number): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output is preserved in tool details.]`;
}

function assistantText(message: Message | undefined): string {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]);
		if (text) return text;
	}
	return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part?.type === "text" && typeof part.text === "string") items.push({ type: "text", text: part.text });
			else if (part?.type === "toolCall" && typeof part.name === "string") {
				items.push({ type: "toolCall", name: part.name, args: part.arguments ?? {} });
			}
		}
	}
	return items;
}

function compactText(value: unknown, maxChars = 500): string {
	let text: string;
	if (typeof value === "string") text = value;
	else if (value === undefined || value === null) text = "";
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = String(value);
		}
	}
	const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function latestNonEmptyLine(text: string): string {
	const lines = text
		.replace(/\r/g, "\n")
		.split("\n")
		.map((line) => compactText(line))
		.filter(Boolean);
	return lines.at(-1) ?? "";
}

function extractAssistantTextDelta(event: unknown): string {
	if (!event || typeof event !== "object") return "";
	const data = event as { type?: string; delta?: unknown; content?: unknown };
	if (data.type === "text_delta" && typeof data.delta === "string") return data.delta;
	if (data.type === "text_end" && typeof data.content === "string") return data.content;
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.errorMessage);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function addUsage(result: SingleResult, message: Message): void {
	if (message.role !== "assistant") return;
	result.usage.turns++;
	const usage = message.usage;
	if (!usage) return;
	result.usage.input += usage.input || 0;
	result.usage.output += usage.output || 0;
	result.usage.cacheRead += usage.cacheRead || 0;
	result.usage.cacheWrite += usage.cacheWrite || 0;
	result.usage.cost += usage.cost?.total || 0;
	result.usage.contextTokens = usage.totalTokens || result.usage.contextTokens;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: limit }, async () => {
		while (true) {
			const index = nextIndex++;
			if (index >= items.length) return;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writeTempFile(prefix: string, name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	const safeName = name.replace(/[^\w.-]+/g, "_") || "subagent";
	const filePath = path.join(dir, `${safeName}.md`);
	await fsp.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function buildChildPrompt(agent: QaAgentConfig, task: string): string {
	return `# Subagent task\n\n## Agent\n- Name: ${agent.name}\n- Source: ${agent.source}\n- Agent file: ${agent.filePath}\n\n## Task\n${task}\n\n## Output requirements\nReturn a concise, evidence-aware answer for the parent agent. If the task asks for uncertainty, conflicts, or missing evidence, state them explicitly.`;
}

function childToolArgs(agent: QaAgentConfig): string[] {
	if (agent.toolMode === "none") return ["--no-tools"];
	if (agent.toolMode === "allowlist" && agent.tools && agent.tools.length > 0) return ["--tools", agent.tools.join(",")];
	return [];
}

async function runSingleAgent(
	defaultCwd: string,
	agents: QaAgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((item) => item.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${formatQaAgentList(agents)}.`,
			usage: emptyUsage(),
			step,
		};
	}

	const current: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step,
	};

	const emitUpdate = (text?: string) => {
		onUpdate?.({
			content: [{ type: "text", text: text || getFinalOutput(current.messages) || `${agentName} running...` }],
			details: makeDetails([current]),
		});
	};

	let systemPromptTmp: { dir: string; filePath: string } | undefined;
	let taskTmp: { dir: string; filePath: string } | undefined;
	let wasAborted = false;

	try {
		const args: string[] = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"-e",
			GR0K_HACK_EXTENSION_PATH,
		];
		args.push(...childToolArgs(agent));
		if (agent.model) args.push("--model", agent.model);
		if (agent.systemPrompt.trim()) {
			systemPromptTmp = await writeTempFile("pi-qa-agent-system-", agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", systemPromptTmp.filePath);
		}
		taskTmp = await writeTempFile("pi-qa-agent-task-", agent.name, buildChildPrompt(agent, task));
		args.push(`@${taskTmp.filePath}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
			let stdoutBuffer = "";
			let assistantDraft = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_start" && event.message?.role === "assistant") assistantDraft = "";

				if (event.type === "message_update" && event.message?.role === "assistant") {
					const delta = extractAssistantTextDelta(event.assistantMessageEvent);
					if (delta) {
						assistantDraft = event.assistantMessageEvent?.type === "text_end" ? delta : assistantDraft + delta;
						const line = latestNonEmptyLine(assistantDraft);
						if (line) emitUpdate(`${agentName}: ${line}`);
					} else {
						const text = assistantText(event.message);
						if (text) {
							assistantDraft = text;
							const line = latestNonEmptyLine(assistantDraft);
							if (line) emitUpdate(`${agentName}: ${line}`);
						}
					}
				}

				if (event.type === "message_end" && event.message) {
					const message = event.message as Message;
					current.messages.push(message);
					if (message.role === "assistant") {
						addUsage(current, message);
						current.model = message.model || current.model;
						current.stopReason = message.stopReason || current.stopReason;
						current.errorMessage = message.errorMessage || current.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					current.messages.push(event.message as Message);
					emitUpdate();
				}

				if (event.type === "agent_end" && Array.isArray(event.messages) && current.messages.length === 0) {
					current.messages.push(...(event.messages as Message[]));
					emitUpdate();
				}

				if (event.type === "tool_execution_start") emitUpdate(`${agentName}: ${event.toolName || "tool"} started`);
				if (event.type === "tool_execution_end") emitUpdate(`${agentName}: ${event.toolName || "tool"} ${event.isError ? "failed" : "done"}`);
			};

			proc.stdout?.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (data) => {
				current.stderr = truncateTail(current.stderr + data.toString(), MAX_STDERR_CHARS);
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				current.stderr = truncateTail(`${current.stderr}\n${error.message}`, MAX_STDERR_CHARS);
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000).unref?.();
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		current.exitCode = exitCode;
		if (wasAborted) {
			current.stopReason = "aborted";
			current.errorMessage = "Subagent was aborted";
		}
		return current;
	} finally {
		for (const tmp of [systemPromptTmp, taskTmp]) {
			if (!tmp) continue;
			await fsp.rm(tmp.dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child pi process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for the prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child pi process" })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks: [{ agent, task }]" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Sequential tasks with optional {previous} placeholders" })),
	agentScope: Type.Optional(
		Type.String({
			description:
				'Agent scopes: "all" (default: bundled package + user + project overrides), "package", "user", or "project".',
		}),
	),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child pi process (single mode)" })),
});

function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.contextTokens = Math.max(total.contextTokens, result.usage.contextTokens);
		total.turns += result.usage.turns;
	}
	return total;
}

function taskPreview(value: string, max = 70): string {
	const cleaned = compactText(value, max + 1);
	return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function formatToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): string {
	const preview = compactText(args, 72);
	return `${theme.fg("muted", "→ ")}${theme.fg("accent", toolName)}${preview ? theme.fg("dim", ` ${preview}`) : ""}`;
}

function renderDisplayItems(items: DisplayItem[], theme: Theme, limit: number | undefined): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = skipped > 0 ? `${theme.fg("muted", `... ${skipped} earlier items`)}\n` : "";
	for (const item of toShow) {
		if (item.type === "toolCall") text += `${formatToolCall(item.name, item.args, theme)}\n`;
		else text += `${theme.fg("toolOutput", limit ? item.text.split("\n").slice(0, 3).join("\n") : item.text)}\n`;
	}
	return text.trimEnd();
}

function renderResultSummary(result: SingleResult, theme: Theme): string {
	const failed = isFailedResult(result);
	const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(result.agent))}${theme.fg("muted", ` (${result.agentSource})`)}`;
	if (failed && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	if (failed && result.errorMessage) text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
	const items = getDisplayItems(result.messages);
	if (items.length > 0) text += `\n${renderDisplayItems(items, theme, COLLAPSED_ITEM_COUNT)}`;
	else text += `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`;
	const usage = formatUsageStats(result.usage, result.model);
	if (usage) text += `\n${theme.fg("dim", usage)}`;
	return text;
}

function maybeConfirmProjectAgents(
	requestedAgentNames: string[],
	agents: QaAgentConfig[],
	projectAgentsDir: string | null,
	confirmProjectAgents: boolean,
	ctx: any,
): Promise<boolean> {
	const requested = new Set(requestedAgentNames);
	const projectAgents = Array.from(requested)
		.map((name) => agents.find((agent) => agent.name === name))
		.filter((agent): agent is QaAgentConfig => agent?.source === "project");
	if (projectAgents.length === 0 || !confirmProjectAgents) return Promise.resolve(true);
	const names = projectAgents.map((agent) => agent.name).join(", ");
	if (!ctx.hasUI) return Promise.resolve(false);
	return ctx.ui.confirm(
		"Run project-local subagents?",
		`Agents: ${names}\nSource: ${projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled prompts. Continue only for trusted repositories.`,
	);
}

export function registerSubagentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized agents in isolated child pi processes.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous}).",
			"gr0k-hack bundles qa-knowledge, qa-web-research, and qa-critic under extensions/gr0k-hack/agents/.",
			"Agent discovery merges bundled package agents, user agents, then trusted project agents so later scopes can override earlier defaults.",
		].join(" "),
		promptSnippet:
			"Delegate a task to a specialized subagent. Supports single, parallel, and chain modes with isolated child pi contexts.",
		promptGuidelines: [
			"Use subagent when a task benefits from isolated specialist reasoning or parallel comparison.",
			"For the gr0k-hack QA workflow, call subagent in parallel with qa-knowledge, qa-web-research, and qa-critic after clarifying the user's question.",
			"subagent honors bundled agent tool policies: tools: none becomes --no-tools, while qa-web-research is limited to qa_web_search.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const discovery = discoverQaAgents(ctx.cwd, params.agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents !== false;
			const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
			const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const mode: SubagentMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope: discovery.scope,
				bundledAgentsDir: discovery.bundledAgentsDir,
				userAgentsDir: discovery.userAgentsDir,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});

			if (modeCount !== 1) {
				return {
					content: [
						{ type: "text", text: `Invalid parameters. Provide exactly one mode. Available agents: ${formatQaAgentList(agents)}` },
					],
					details: makeDetails([]),
				};
			}

			const requestedNames: string[] = [];
			if (hasSingle) requestedNames.push(params.agent);
			if (hasTasks) for (const task of params.tasks) requestedNames.push(task.agent);
			if (hasChain) for (const step of params.chain) requestedNames.push(step.agent);
			const approved = await maybeConfirmProjectAgents(
				requestedNames,
				agents,
				discovery.projectAgentsDir,
				confirmProjectAgents,
				ctx,
			);
			if (!approved) {
				return {
					content: [{ type: "text", text: "Canceled: project-local subagents were not approved." }],
					details: makeDetails([]),
					isError: true,
				};
			}

			if (hasChain) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
					const chainUpdate = onUpdate
						? (partial: ToolResultPatch) => {
								const current = partial.details?.results[0];
								if (!current) return;
								onUpdate({ ...partial, details: makeDetails([...results, current]) });
							}
						: undefined;
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails,
					);
					results.push(result);
					if (isFailedResult(result)) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` }],
							details: makeDetails(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1]?.messages ?? []) || "(no output)" }],
					details: makeDetails(results),
				};
			}

			if (hasTasks) {
				if (params.tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails([]),
						isError: true,
					};
				}

				const allResults: SingleResult[] = params.tasks.map((task: any) => ({
					agent: task.agent,
					agentSource: "unknown",
					task: task.task,
					exitCode: -1,
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				}));
				const emitParallelUpdate = () => {
					const running = allResults.filter((result) => result.exitCode === -1).length;
					const done = allResults.length - running;
					onUpdate?.({
						content: [{ type: "text", text: `Parallel subagents: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task: any, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						task.agent,
						task.task,
						task.cwd,
						undefined,
						signal,
						(partial) => {
							const current = partial.details?.results[0];
							if (!current) return;
							allResults[index] = current;
							emitParallelUpdate();
						},
						makeDetails,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map((result) => {
					const status = isFailedResult(result)
						? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
						: "completed";
					return `### [${result.agent}] ${status}\n\n${truncateByBytes(getResultOutput(result), PER_TASK_OUTPUT_CAP)}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails(results),
					isError: successCount === 0,
				};
			}

			const result = await runSingleAgent(
				ctx.cwd,
				agents,
				params.agent,
				params.task,
				params.cwd,
				undefined,
				signal,
				onUpdate,
				makeDetails,
			);
			if (isFailedResult(result)) {
				return {
					content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
					details: makeDetails([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
				details: makeDetails([result]),
			};
		},

		renderCall(args: any, theme) {
			const scope = args.agentScope || "all";
			if (args.chain?.length) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}${theme.fg("muted", ` [${scope}]`)}`;
				for (const [index, step] of args.chain.slice(0, 3).entries()) text += `\n  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", taskPreview(step.task.replace(/\{previous\}/g, "")))}`;
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks?.length) {
				let text = `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}${theme.fg("muted", ` [${scope}]`)}`;
				for (const task of args.tasks.slice(0, 3)) text += `\n  ${theme.fg("accent", task.agent)} ${theme.fg("dim", taskPreview(task.task))}`;
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", args.agent || "...")}${theme.fg("muted", ` [${scope}]`)}\n  ${theme.fg("dim", taskPreview(args.task || "..."))}`,
				0,
				0,
			);
		},

		renderResult(result: any, { expanded }: { expanded?: boolean }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content?.[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			if (expanded) {
				const mdTheme = getMarkdownTheme();
				const container = new Container();
				const successCount = details.results.filter((entry) => entry.exitCode !== -1 && !isFailedResult(entry)).length;
				const running = details.results.filter((entry) => entry.exitCode === -1).length;
				container.addChild(
					new Text(
						`${theme.fg(running ? "warning" : "success", running ? "⏳" : "✓")} ${theme.fg("toolTitle", theme.bold(details.mode))} ${theme.fg("accent", `${successCount}/${details.results.length} succeeded`)}${running ? theme.fg("muted", ` · ${running} running`) : ""}`,
						0,
						0,
					),
				);
				for (const entry of details.results) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(renderResultSummary(entry, theme), 0, 0));
					const finalOutput = getFinalOutput(entry.messages);
					if (finalOutput) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
					}
				}
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
				}
				return container;
			}

			const running = details.results.filter((entry) => entry.exitCode === -1).length;
			const successCount = details.results.filter((entry) => entry.exitCode !== -1 && !isFailedResult(entry)).length;
			const failCount = details.results.filter((entry) => entry.exitCode !== -1 && isFailedResult(entry)).length;
			const icon = running ? theme.fg("warning", "⏳") : failCount ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			let text = `${icon} ${theme.fg("toolTitle", theme.bold(details.mode))} ${theme.fg("accent", `${successCount}/${details.results.length} succeeded`)}${running ? theme.fg("muted", ` · ${running} running`) : ""}`;
			for (const entry of details.results) text += `\n\n${renderResultSummary(entry, theme)}`;
			if (!running) {
				const usage = formatUsageStats(aggregateUsage(details.results));
				if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
			}
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
