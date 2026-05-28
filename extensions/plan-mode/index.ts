/**
 * Plan mode + plan-agent extension.
 *
 * /plan enters a read-only planning mode. In that mode the main agent can call
 * the plan_agent tool, which spawns the bundled agents/plan-agent.md
 * agent in an isolated pi process. The child process is guarded by sandbox.ts:
 * repository read-only access plus write/edit/delete only under .plan/ for the markdown plan and todo JSONL.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const PLAN_AGENT_NAME = "plan-agent";
const PLAN_DIR = ".plan";
const TODO_PATH = `${PLAN_DIR}/todo.jsonl`;
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "bash", "plan_agent"];
const DEFAULT_PLAN_AGENT_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"write",
	"edit",
	"plan_web_search",
	"plan_delete",
];
const MAX_PARENT_SYSTEM_PROMPT_CHARS = 100_000;
const MAX_STDERR_CHARS = 20_000;
const MAX_PLAN_PREVIEW_CHARS = 80_000;
const MAX_PLAN_HANDOFF_CHARS = 120_000;
const PLAN_PREVIEW_CUSTOM_TYPE = "plan-mode-exit-plan-preview";
const PLAN_HANDOFF_CUSTOM_TYPE = "plan-mode-exit-handoff";
const PLAN_CONTEXT_RESET_CUSTOM_TYPE = "plan-mode-context-reset";
const PLAN_EXIT_EXECUTE_OPTION = "plan没问题，允许退出plan mode，开始执行";
const PLAN_EXIT_SHELVE_OPTION = "允许退出plan mode，先搁置";
const PLAN_EXIT_REVISE_OPTION = "不允许退出，需要修改：{修改意见}";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_EXTENSION_PATH = path.join(EXTENSION_DIR, "sandbox.ts");
const PLAN_AGENT_PATH = path.join(EXTENSION_DIR, "agents", `${PLAN_AGENT_NAME}.md`);

interface PlanAgentConfig {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

interface PlanAgentRunOptions {
	prompt: string;
	outputPath?: string;
	signal?: AbortSignal;
	onStatus?: (status: string) => void;
}

interface PlanAgentRunResult {
	planPath: string;
	absolutePlanPath: string;
	planExists: boolean;
	todoPath: string;
	absoluteTodoPath: string;
	todoExists: boolean;
	exitCode: number;
	finalOutput: string;
	stderr: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

type PlanReviewSource = "command" | "tool";
type PlanExitDecision = "execute" | "shelve" | "explicit";

interface PlanReviewRequest {
	id: string;
	source: PlanReviewSource;
	prompt: string;
	planPath: string;
	absolutePlanPath: string;
	todoPath: string;
	absoluteTodoPath: string;
	createdAt: string;
	result: PlanAgentRunResult;
}

interface PlanContentRead {
	content: string;
	truncated: boolean;
	error?: string;
}

interface PlanExitHandoff {
	id: string;
	decision: PlanExitDecision;
	originalPrompt: string;
	planPath: string;
	absolutePlanPath: string;
	todoPath: string;
	absoluteTodoPath: string;
	planContent: string;
	planContentTruncated: boolean;
	createdAt: string;
}

type PlanTodoStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped" | "cancelled" | "failed" | string;

interface PlanTodoItem {
	type?: string;
	schemaVersion?: number;
	planPath?: string;
	step: number;
	title: string;
	description?: string;
	status: PlanTodoStatus;
	priority?: string;
	dependencies?: Array<string | number>;
	validation?: string[];
	createdAt?: string;
	startedAt?: string;
	updatedAt?: string;
	completedAt?: string;
	lineNumber: number;
}

interface ParsedTodoFile {
	path: string;
	relativePath: string;
	todos: PlanTodoItem[];
	errors: string[];
	mtimeMs: number;
	loadedAt: number;
}

type TodoSidebarResult = { type: "close" };

type KenxSidebarBridge = {
	isFileTreeOpen(): boolean;
	closeFileTree(): boolean;
};

const KENX_SIDEBAR_BRIDGE_KEY = Symbol.for("yoyo-pi.kenx-infra.sidebar");
const TODO_STATUS_ACTIVE = new Set(["active", "doing", "in-progress", "in_progress", "now", "running", "started"]);
const TODO_STATUS_DONE = new Set(["complete", "completed", "done", "success", "succeeded"]);
const TODO_STATUS_BLOCKED = new Set(["blocked", "error", "failed", "failure"]);
const TODO_STATUS_SKIPPED = new Set(["cancelled", "canceled", "skipped"]);

function isInside(child: string, root: string): boolean {
	const relative = path.relative(root, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 54);
	return slug || "plan";
}

function timestampForFile(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizePlanPath(cwd: string, prompt: string, requested?: string): { relative: string; absolute: string } {
	const planRoot = path.resolve(cwd, PLAN_DIR);
	let target: string;

	if (requested?.trim()) {
		const cleaned = stripAtPrefix(requested.trim());
		target = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
		if (!path.extname(target)) target += ".md";
	} else {
		target = path.join(planRoot, `${timestampForFile()}-${slugify(prompt)}.md`);
	}

	if (!isInside(target, planRoot)) {
		throw new Error(`Plan output path must be inside ${PLAN_DIR}/ (got ${requested ?? target})`);
	}

	return { relative: path.relative(cwd, target) || path.join(PLAN_DIR, path.basename(target)), absolute: target };
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const keep = Math.floor((maxChars - 120) / 2);
	return `${text.slice(0, keep)}\n\n[... truncated ${text.length - keep * 2} characters ...]\n\n${text.slice(-keep)}`;
}

function truncateTail(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `[... truncated ${text.length - maxChars} characters ...]\n${text.slice(-maxChars)}`;
}

function loadPlanAgent(): PlanAgentConfig {
	const filePath = PLAN_AGENT_PATH;
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing bundled agent: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");
	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	const tools = frontmatter.tools
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);

	return {
		name: frontmatter.name || PLAN_AGENT_NAME,
		description: frontmatter.description || "Writes implementation plans under .plan/",
		tools: tools && tools.length > 0 ? tools : DEFAULT_PLAN_AGENT_TOOLS,
		model: frontmatter.model?.trim() || undefined,
		systemPrompt: body.trim(),
		filePath,
	};
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

function assistantText(message: any): string {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = assistantText(messages[i]);
		if (text) return text;
	}
	return "";
}

function buildTaskPrompt(
	userPrompt: string,
	planPath: string,
	parentSystemPrompt: string,
	agent: PlanAgentConfig,
): string {
	const truncatedSystemPrompt = truncateMiddle(parentSystemPrompt, MAX_PARENT_SYSTEM_PROMPT_CHARS);
	const taskCreatedAt = new Date().toISOString();
	return `# ${PLAN_AGENT_NAME} task

## User prompt
${userPrompt}

## Required output files
Create or update both outputs in the current repository:

- Markdown plan: \`${planPath}\`
- Todo JSONL file: \`${TODO_PATH}\`

## Todo output requirements
- Derive todos directly from the final markdown plan's \`## Plan\` steps.
- Rewrite \`${TODO_PATH}\` so it contains todos for this plan only; do not leave stale todos from older plans.
- Write one compact, valid JSON object per line. Do not wrap the JSONL in markdown fences.
- Keep todo \`step\` values in the same order as the markdown plan steps and start at 1.
- Use \`status: "pending"\` for every new todo.
- Use this task timestamp for every todo: \`${taskCreatedAt}\`.
- Required JSONL fields per line:

\`\`\`jsonl
{"type":"plan_todo","schemaVersion":1,"planPath":"${planPath}","step":1,"title":"Short actionable title","description":"Concrete implementation task tied to the plan step","status":"pending","priority":"medium","dependencies":[],"validation":["Check or test for this step"],"createdAt":"${taskCreatedAt}"}
\`\`\`

## Parent session system prompt
The parent pi session supplied this system prompt/context. Use it as authoritative higher-level guidance alongside your own plan-agent instructions and repository instructions.

\`\`\`text
${truncatedSystemPrompt || "(empty)"}
\`\`\`

## Repository instructions
Pi will load repository context files such as AGENTS.md and CLAUDE.md automatically. Also search for and read relevant guidance files when present, including AGENTS.md, agent.md, Agent.md, CLAUDE.md, and .github/copilot-instructions.md.

## Required workflow
1. Understand the user's request and any constraints from the parent system prompt.
2. Search the codebase with read-only tools (grep/find/ls/read, and read-only bash if useful).
3. Use plan_web_search for external docs, APIs, libraries, or error messages when that would improve the plan.
4. Do code checking by inspecting relevant code paths. If a runtime check would modify files outside ${PLAN_DIR}/, skip it and note that limitation.
5. Create or update the markdown plan at \`${planPath}\` using write/edit.
6. Create or replace the todo JSONL file at \`${TODO_PATH}\` using write/edit, following the schema above.
7. Do not change files outside ${PLAN_DIR}/. Within ${PLAN_DIR}/, only modify the requested plan file, \`${TODO_PATH}\`, or obsolete plan files that you explicitly delete with plan_delete.
8. Return a concise summary that includes the plan path, todo path, and the most important risks/next steps.

## Loaded bundled agent
- Agent file: ${agent.filePath}
- Agent name: ${agent.name}
- Allowed child tools: ${agent.tools.join(", ")}
`;
}

async function runPlanAgent(ctx: ExtensionContext, options: PlanAgentRunOptions): Promise<PlanAgentRunResult> {
	const agent = loadPlanAgent();
	const { relative: planPath, absolute: absolutePlanPath } = normalizePlanPath(ctx.cwd, options.prompt, options.outputPath);
	const todoPath = TODO_PATH;
	const absoluteTodoPath = path.resolve(ctx.cwd, TODO_PATH);
	const parentSystemPrompt = (() => {
		try {
			return ctx.getSystemPrompt();
		} catch {
			return "";
		}
	})();

	if (!fs.existsSync(SANDBOX_EXTENSION_PATH)) {
		throw new Error(`Missing plan-agent sandbox extension: ${SANDBOX_EXTENSION_PATH}`);
	}

	let tmpDir: string | undefined;
	const messages: any[] = [];
	let stderr = "";
	let model: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;

	try {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-plan-agent-"));
		const taskPath = path.join(tmpDir, "task.md");
		await fsp.writeFile(taskPath, buildTaskPrompt(options.prompt, planPath, parentSystemPrompt, agent), "utf-8");

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"-e",
			SANDBOX_EXTENSION_PATH,
			"--tools",
			agent.tools.join(","),
		];
		if (agent.model) args.push("--model", agent.model);
		if (agent.systemPrompt) args.push("--append-system-prompt", agent.systemPrompt);
		args.push(`@${taskPath}`);

		options.onStatus?.(`spawning ${PLAN_AGENT_NAME}...`);
		const invocation = getPiInvocation(args);

		let stdoutBuffer = "";
		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					messages.push(event.message);
					if (event.message.role === "assistant") {
						model = event.message.model || model;
						stopReason = event.message.stopReason || stopReason;
						errorMessage = event.message.errorMessage || errorMessage;
					}
				}

				if (event.type === "tool_result_end" && event.message) {
					messages.push(event.message);
				}

				if (event.type === "agent_end" && Array.isArray(event.messages) && messages.length === 0) {
					messages.push(...event.messages);
				}

				if (event.type === "tool_execution_start") {
					options.onStatus?.(`${PLAN_AGENT_NAME}: ${event.toolName || "tool"}...`);
				}
				if (event.type === "tool_execution_end") {
					options.onStatus?.(`${PLAN_AGENT_NAME}: ${event.toolName || "tool"} done`);
				}
			};

			proc.stdout?.on("data", (data) => {
				stdoutBuffer += data.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				stderr += `\n${error.message}`;
				resolve(1);
			});

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000).unref?.();
				};
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		if (wasAborted) throw new Error(`${PLAN_AGENT_NAME} was aborted`);

		const planExists = fs.existsSync(absolutePlanPath);
		const todoExists = fs.existsSync(absoluteTodoPath);
		return {
			planPath,
			absolutePlanPath,
			planExists,
			todoPath,
			absoluteTodoPath,
			todoExists,
			exitCode,
			finalOutput: getFinalOutput(messages),
			stderr: truncateTail(stderr.trim(), MAX_STDERR_CHARS),
			model,
			stopReason,
			errorMessage,
		};
	} finally {
		if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
	}
}

function isPlanAgentProcessOk(result: PlanAgentRunResult): boolean {
	return result.exitCode === 0 && !result.errorMessage && result.stopReason !== "error" && result.stopReason !== "aborted";
}

function isPlanAgentRunOk(result: PlanAgentRunResult): boolean {
	return isPlanAgentProcessOk(result) && result.planExists && result.todoExists;
}

function formatPlanAgentResult(result: PlanAgentRunResult): string {
	const processOk = isPlanAgentProcessOk(result);
	const outputsOk = result.planExists && result.todoExists;
	const ok = processOk && outputsOk;
	const status = processOk
		? outputsOk
			? "Plan agent finished."
			: "Plan agent finished with missing required outputs."
		: `Plan agent failed (exit ${result.exitCode}).`;
	const fileStatus = result.planExists ? `Plan file: ${result.planPath}` : `Plan file was not created: ${result.planPath}`;
	const todoStatus = result.todoExists ? `Todo file: ${result.todoPath}` : `Todo file was not created: ${result.todoPath}`;
	const parts = [status, fileStatus, todoStatus];
	if (result.finalOutput) parts.push(result.finalOutput);
	if (!ok && result.errorMessage) parts.push(`Error: ${result.errorMessage}`);
	if (!ok && result.stderr) parts.push(`stderr:\n${result.stderr}`);
	return parts.join("\n\n");
}

function createPlanReview(prompt: string, result: PlanAgentRunResult, source: PlanReviewSource): PlanReviewRequest {
	return {
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		source,
		prompt,
		planPath: result.planPath,
		absolutePlanPath: result.absolutePlanPath,
		todoPath: result.todoPath,
		absoluteTodoPath: result.absoluteTodoPath,
		createdAt: new Date().toISOString(),
		result,
	};
}

function safeContextIsIdle(ctx: ExtensionContext): boolean {
	try {
		return ctx.isIdle();
	} catch {
		return true;
	}
}

function sendPlanCustomMessage(
	pi: ExtensionAPI,
	_ctx: ExtensionContext,
	message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
	options: { triggerTurn?: boolean } = {},
): void {
	pi.sendMessage(message as any, { triggerTurn: options.triggerTurn ?? false } as any);
}

function sendPlanUserMessage(pi: ExtensionAPI, ctx: ExtensionContext, content: string): void {
	if (safeContextIsIdle(ctx)) pi.sendUserMessage(content);
	else pi.sendUserMessage(content, { deliverAs: "followUp" });
}

async function readPlanContent(filePath: string, maxChars: number): Promise<PlanContentRead> {
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		if (raw.length <= maxChars) return { content: raw, truncated: false };
		return {
			content: `${raw.slice(0, maxChars)}\n\n[... truncated ${raw.length - maxChars} characters; open the plan file for the full content ...]`,
			truncated: true,
		};
	} catch (error) {
		return {
			content: "",
			truncated: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function buildPlanPreviewContent(review: PlanReviewRequest, plan: PlanContentRead): string {
	const header = `# Plan preview before exiting plan mode\n\nPlan file: \`${review.planPath}\`\nTodo file: \`${review.todoPath}\``;
	if (plan.error) {
		return `${header}\n\nCould not read the plan file before exit: ${plan.error}`;
	}
	const truncation = plan.truncated
		? `\n\n> Preview truncated. Open \`${review.planPath}\` for the full plan.`
		: "";
	return `${header}${truncation}\n\n---\n\n${plan.content || "(plan file is empty)"}`;
}

function buildPlanHandoffContent(handoff: PlanExitHandoff): string {
	const truncation = handoff.planContentTruncated
		? "\n\nNote: The plan content below is truncated; use the plan file for the complete version."
		: "";
	return `[PLAN MODE EXIT HANDOFF]\nThe planning conversation before this handoff was intentionally removed from future LLM context. Use only this original prompt, plan, todo path, and newer messages.\n\n## Original user prompt\n${handoff.originalPrompt}\n\n## Plan file\n${handoff.planPath}\n\n## Todo file\n${handoff.todoPath}${truncation}\n\n## Plan content\n${handoff.planContent || "(plan file is empty or unavailable)"}`;
}

function buildPlanExecuteKickoffPrompt(handoff: PlanExitHandoff): string {
	return `Execute the approved plan now.\n\nOriginal user prompt:\n${handoff.originalPrompt}\n\nPlan file: ${handoff.planPath}\nTodo JSONL: ${handoff.todoPath}\n\nUse the plan-mode exit handoff context as the source of truth. Keep ${handoff.todoPath} updated as you work: set each todo to in_progress before starting it, done with completedAt after finishing it, and blocked with an explanation if you cannot proceed.`;
}

function buildPlanRevisePrompt(review: PlanReviewRequest, feedback: string): string {
	return `The user did not allow exiting plan mode and requested changes to the plan.\n\nOriginal planning prompt:\n${review.prompt}\n\nCurrent plan file: ${review.planPath}\nTodo JSONL: ${review.todoPath}\n\nUser modification feedback:\n${feedback}\n\nStay in plan mode. Call plan_agent again with outputPath \`${review.planPath}\`, incorporate the feedback, and rewrite ${review.todoPath} to match the revised plan. Do not implement the plan.`;
}

const PlanAgentParams = Type.Object({
	prompt: Type.String({ description: "The user's planning request to delegate to plan-agent." }),
	outputPath: Type.Optional(
		Type.String({ description: "Optional markdown output path. Must be inside .plan/. Defaults to a timestamped file." }),
	),
});

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_READONLY_PATTERNS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|ps|rg|fd|bat|eza)\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|view|info|why|audit)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python3?\s+--version\b/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/i,
];

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	const regex = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(command))) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

function looksLikePath(token: string): boolean {
	if (!token || token.startsWith("-")) return false;
	if (/^[a-z]+:\/\//i.test(token)) return false;
	return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.includes("/");
}

function commandReferencesOutsideRepo(command: string, cwd: string): boolean {
	const root = path.resolve(cwd);
	for (const token of shellTokens(command)) {
		if (!looksLikePath(token)) continue;
		const cleaned = stripAtPrefix(token.replace(/[,:;]+$/g, ""));
		const absolute = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
		if (!isInside(absolute, root)) return true;
	}
	return false;
}

function isReadOnlyBash(command: string, cwd: string): { ok: boolean; reason?: string } {
	if (!command.trim()) return { ok: false, reason: "empty command" };
	if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
		return { ok: false, reason: "destructive or file-mutating command" };
	}
	if (/[`$]\(/.test(command)) return { ok: false, reason: "command substitution is not allowed in plan mode" };
	if (commandReferencesOutsideRepo(command, cwd)) return { ok: false, reason: "command references a path outside the repo" };

	const segments = command
		.split(/\s*(?:&&|\|\||;|\n|\|)\s*/g)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return { ok: false, reason: "empty command" };
	for (const segment of segments) {
		if (!SAFE_READONLY_PATTERNS.some((pattern) => pattern.test(segment))) {
			return { ok: false, reason: `not an allowlisted read-only command: ${segment}` };
		}
	}
	return { ok: true };
}

let closeTodoSidebar: (() => void) | null = null;
let activeTodoSidebarPanel: TodoSidebarPanel | undefined;
let latestTodoSnapshot: ParsedTodoFile | undefined;
let todoWorkflowActive = false;
let todoSidebarWidth = 34;
let todoSidebarMaxHeight: OverlayOptions["maxHeight"] = 40;

function getKenxSidebarBridge(): KenxSidebarBridge | undefined {
	return (globalThis as Record<symbol, KenxSidebarBridge | undefined>)[KENX_SIDEBAR_BRIDGE_KEY];
}

function closeFileTreeSidebarIfOpen(): boolean {
	try {
		return getKenxSidebarBridge()?.closeFileTree() ?? false;
	} catch {
		return false;
	}
}

function normalizeTodoStatus(status: unknown): string {
	return String(status || "pending")
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "_")
		.replace(/-/g, "_");
}

function statusMatches(status: string, values: Set<string>): boolean {
	return values.has(status) || values.has(status.replace(/_/g, "-"));
}

function isTodoDone(todo: PlanTodoItem): boolean {
	return statusMatches(normalizeTodoStatus(todo.status), TODO_STATUS_DONE);
}

function isTodoSkipped(todo: PlanTodoItem): boolean {
	return statusMatches(normalizeTodoStatus(todo.status), TODO_STATUS_SKIPPED);
}

function isTodoActive(todo: PlanTodoItem): boolean {
	return statusMatches(normalizeTodoStatus(todo.status), TODO_STATUS_ACTIVE);
}

function isTodoBlocked(todo: PlanTodoItem): boolean {
	return statusMatches(normalizeTodoStatus(todo.status), TODO_STATUS_BLOCKED);
}

function isTodoOpen(todo: PlanTodoItem): boolean {
	return !isTodoDone(todo) && !isTodoSkipped(todo);
}

function cleanTodoText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	return cleaned || undefined;
}

function coerceStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.map((item) => cleanTodoText(item)).filter((item): item is string => Boolean(item));
	return items.length > 0 ? items : undefined;
}

function coerceDependencyArray(value: unknown): Array<string | number> | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
	return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function relativeDisplayPath(cwd: string, absolutePath: string): string {
	const rel = path.relative(cwd, absolutePath).split(path.sep).join("/");
	return rel || path.basename(absolutePath);
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatClock(value: number | undefined = Date.now()): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "--:--";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "+0s";
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `+${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `+${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `+${seconds}s`;
}

function truncatePlain(value: string, width: number): string {
	return truncateToWidth(value, width, "…", true);
}

function padAnsi(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "…", true);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function readJsonObjectLine(line: string, lineNumber: number): { object?: Record<string, unknown>; error?: string } {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed)) return { error: `line ${lineNumber}: not an object` };
		return { object: parsed };
	} catch (error) {
		return { error: `line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function coerceTodoObject(object: Record<string, unknown>, lineNumber: number, fallbackStep: number): PlanTodoItem | undefined {
	const explicitType = cleanTodoText(object.type);
	const title = cleanTodoText(object.title) ?? cleanTodoText(object.text) ?? cleanTodoText(object.description);
	if (explicitType && explicitType !== "plan_todo" && !title) return undefined;
	if (!title) return undefined;

	const numericStep = Number(object.step);
	const step = Number.isFinite(numericStep) && numericStep > 0 ? Math.floor(numericStep) : fallbackStep;
	const status = cleanTodoText(object.status) ?? "pending";

	return {
		type: explicitType,
		schemaVersion: Number.isFinite(Number(object.schemaVersion)) ? Number(object.schemaVersion) : undefined,
		planPath: cleanTodoText(object.planPath),
		step,
		title,
		description: cleanTodoText(object.description),
		status,
		priority: cleanTodoText(object.priority),
		dependencies: coerceDependencyArray(object.dependencies),
		validation: coerceStringArray(object.validation),
		createdAt: cleanTodoText(object.createdAt),
		startedAt: cleanTodoText(object.startedAt),
		updatedAt: cleanTodoText(object.updatedAt),
		completedAt: cleanTodoText(object.completedAt),
		lineNumber,
	};
}

async function readTodoJsonlFile(absolutePath: string, cwd: string): Promise<ParsedTodoFile> {
	const stat = await fsp.stat(absolutePath);
	const raw = await fsp.readFile(absolutePath, "utf8");
	const todos: PlanTodoItem[] = [];
	const errors: string[] = [];
	let fallbackStep = 1;

	const lines = raw.split(/\r?\n/g);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		const { object, error } = readJsonObjectLine(line, index + 1);
		if (error) {
			errors.push(error);
			continue;
		}
		if (!object) continue;
		const todo = coerceTodoObject(object, index + 1, fallbackStep);
		if (!todo) continue;
		todos.push(todo);
		fallbackStep = Math.max(fallbackStep + 1, todo.step + 1);
	}

	todos.sort((a, b) => a.step - b.step || a.lineNumber - b.lineNumber);
	return {
		path: absolutePath,
		relativePath: relativeDisplayPath(cwd, absolutePath),
		todos,
		errors,
		mtimeMs: stat.mtimeMs,
		loadedAt: Date.now(),
	};
}

async function collectJsonlFiles(dir: string, out: string[], depth = 0): Promise<void> {
	if (depth > 4) return;
	let dirents: fs.Dirent[];
	try {
		dirents = await fsp.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const dirent of dirents) {
		const child = path.join(dir, dirent.name);
		if (dirent.isDirectory()) {
			await collectJsonlFiles(child, out, depth + 1);
		} else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".jsonl")) {
			out.push(child);
		}
	}
}

async function fileLooksLikePlanTodo(filePath: string): Promise<boolean> {
	try {
		const raw = await fsp.readFile(filePath, "utf8");
		const sample = raw.slice(0, 24_000);
		return /"type"\s*:\s*"plan_todo"/.test(sample) || (/"step"\s*:/.test(sample) && /"status"\s*:/.test(sample));
	} catch {
		return false;
	}
}

async function findTodoJsonlFile(cwd: string): Promise<string | undefined> {
	const planRoot = path.resolve(cwd, PLAN_DIR);
	const directTodo = path.resolve(cwd, TODO_PATH);
	if (fs.existsSync(directTodo)) return directTodo;
	if (!fs.existsSync(planRoot)) return undefined;

	const files: string[] = [];
	await collectJsonlFiles(planRoot, files);
	if (files.length === 0) return undefined;

	const candidates: Array<{ file: string; score: number; mtimeMs: number }> = [];
	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = await fsp.stat(file);
		} catch {
			continue;
		}
		const base = path.basename(file).toLowerCase();
		const looksLikeTodo = await fileLooksLikePlanTodo(file);
		let score = looksLikeTodo ? 1_000 : 0;
		if (base === "todo.jsonl") score += 500;
		else if (base.includes("todo")) score += 100;
		candidates.push({ file, score, mtimeMs: stat.mtimeMs });
	}

	candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
	return candidates[0]?.file;
}

function preferredTodoSidebarLayout(snapshot: ParsedTodoFile | undefined): { width: number; maxHeight: number } {
	const todos = snapshot?.todos ?? [];
	const longestTodo = todos.reduce((max, todo) => Math.max(max, visibleWidth(`${todo.step}. ${todo.title}`)), 0);
	const longestPath = visibleWidth(snapshot?.relativePath ?? TODO_PATH);
	const width = clamp(Math.max(34, longestTodo + 13, longestPath + 10), 34, 58);
	// Include the fixed chrome/footer rows in the requested overlay height.
	// If this is too small, pi's overlay compositor clips from the bottom and the closing border disappears.
	const maxHeight = clamp(Math.min(40, Math.max(18, todos.length + 16)), 18, 40);
	return { width, maxHeight };
}

function latestTodoTime(todos: PlanTodoItem[]): number | undefined {
	const timestamps = todos
		.flatMap((todo) => [todo.completedAt, todo.updatedAt, todo.startedAt, todo.createdAt])
		.map(parseTimestamp)
		.filter((value): value is number => value !== undefined);
	return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function firstTodoTime(todos: PlanTodoItem[]): number | undefined {
	const timestamps = todos
		.flatMap((todo) => [todo.createdAt, todo.startedAt, todo.updatedAt, todo.completedAt])
		.map(parseTimestamp)
		.filter((value): value is number => value !== undefined);
	return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function currentTodoIndex(todos: PlanTodoItem[]): number {
	const active = todos.findIndex((todo) => isTodoActive(todo) || isTodoBlocked(todo));
	if (active >= 0) return active;
	const open = todos.findIndex(isTodoOpen);
	return open >= 0 ? open : todos.length;
}

function todoSnapshotContext(snapshot: ParsedTodoFile | undefined): string | undefined {
	if (!snapshot || snapshot.todos.length === 0) return undefined;
	const remaining = snapshot.todos.filter(isTodoOpen);
	if (remaining.length === 0) return undefined;
	const lines = remaining
		.slice(0, 12)
		.map((todo) => `${todo.step}. [${todo.status}] ${todo.title}${todo.description ? ` — ${todo.description}` : ""}`);
	const omitted = remaining.length > lines.length ? `\n... ${remaining.length - lines.length} more remaining todo(s)` : "";
	return `[TODO WORKFLOW ACTIVE]
The todo workflow is monitoring ${snapshot.relativePath}. Keep this JSONL file up to date as you work.
Use status values: pending, in_progress, done, blocked (or skipped/cancelled when appropriate).
Before starting a step, rewrite its JSONL object with status "in_progress" and updatedAt. After finishing it, rewrite status "done" with completedAt. If blocked, use status "blocked" and explain why in description.

Remaining todos:
${lines.join("\n")}${omitted}`;
}

function buildTodoCommandPrompt(userPrompt: string): string {
	const createdAt = new Date().toISOString();
	const planPath = path.join(PLAN_DIR, `${timestampForFile()}-todo-${slugify(userPrompt)}.md`).split(path.sep).join("/");
	return `# Todo-driven execution request

Goal: ${userPrompt}

Create a todo plan first, then execute it.

Required files:
- Markdown plan: \`${planPath}\`
- Todo JSONL: \`${TODO_PATH}\`

Todo JSONL requirements:
- Rewrite \`${TODO_PATH}\` with todos for this request only.
- Use one compact valid JSON object per line, no markdown fences.
- Use \`type: "plan_todo"\` and \`schemaVersion: 1\`.
- Keep \`step\` values ordered from 1.
- Use this timestamp for initial \`createdAt\`: \`${createdAt}\`.
- Required fields per line:

\`\`\`jsonl
{"type":"plan_todo","schemaVersion":1,"planPath":"${planPath}","step":1,"title":"Short actionable title","description":"Concrete implementation task","status":"pending","priority":"medium","dependencies":[],"validation":["Check or test for this step"],"createdAt":"${createdAt}"}
\`\`\`

Execution workflow:
1. Inspect the repo enough to decompose the goal into concrete steps.
2. Write the markdown plan and initial \`${TODO_PATH}\` before changing implementation files.
3. Execute steps in order. Before working on a step, update its JSONL status to \`in_progress\` and set \`updatedAt\`.
4. When a step is complete, update its status to \`done\` and set \`completedAt\`.
5. If a step cannot proceed, set status \`blocked\` and include the blocker in \`description\`.
6. Keep the todo file compact and valid after every update so the sidebar can monitor progress.

Start now.`;
}

class TodoSidebarPanel implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly cwd: string;
	private readonly done: (result: TodoSidebarResult) => void;
	private readonly onLayoutChange: (layout: { width: number; maxHeight: number }) => void;
	private readonly onSnapshotChange: (snapshot: ParsedTodoFile | undefined) => void;

	private sourcePath: string | undefined;
	private snapshot: ParsedTodoFile | undefined;
	private loading = true;
	private error: string | undefined;
	private closed = false;
	private disposed = false;
	private refreshing = false;
	private refreshAgain = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private dirWatcher: fs.FSWatcher | undefined;
	private fileWatcher: fs.FSWatcher | undefined;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		cwd: string;
		initialPath?: string;
		done: (result: TodoSidebarResult) => void;
		onLayoutChange: (layout: { width: number; maxHeight: number }) => void;
		onSnapshotChange: (snapshot: ParsedTodoFile | undefined) => void;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.cwd = options.cwd;
		this.done = options.done;
		this.onLayoutChange = options.onLayoutChange;
		this.onSnapshotChange = options.onSnapshotChange;
		if (options.initialPath) this.setWatchedFile(options.initialPath);
		void this.start();
	}

	setSourcePath(filePath: string): void {
		this.setWatchedFile(filePath);
		void this.refresh(true);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+shift+t")) {
			this.close();
		}
	}

	render(width: number): string[] {
		const w = Math.max(30, width);
		const th = this.theme;
		const lines: string[] = [this.topBar(w)];
		lines.push(this.blank(w));

		if (this.loading && !this.snapshot) {
			lines.push(this.row(w, ` ${th.fg("warning", "loading todos…")}`));
			lines.push(this.row(w, ` ${th.fg("dim", "watching .plan/*.jsonl")}`));
		} else if (!this.snapshot) {
			lines.push(this.row(w, ` ${th.fg("dim", "no todo JSONL found")}`));
			lines.push(this.row(w, ` ${th.fg("dim", "run /todo <prompt> to start")}`));
			if (this.error) lines.push(this.row(w, ` ${th.fg("warning", this.error)}`));
		} else if (this.snapshot.todos.length === 0) {
			lines.push(this.row(w, ` ${th.fg("warning", "no plan_todo entries")}`));
			lines.push(this.row(w, ` ${th.fg("dim", this.snapshot.relativePath)}`));
			if (this.error) lines.push(this.row(w, ` ${th.fg("warning", this.error)}`));
		} else {
			lines.push(...this.renderTimeline(w, this.snapshot));
		}

		const footer = [this.blank(w), this.botBar(w)];
		const maxRows = this.maxRenderRows();
		if (lines.length + footer.length > maxRows) {
			const cutAt = Math.max(1, maxRows - footer.length - 1);
			lines.splice(cutAt);
			lines.push(this.row(w, ` ${this.theme.fg("dim", "… clipped to fit terminal")}`));
		}
		lines.push(...footer);
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = undefined;
		this.dirWatcher?.close();
		this.dirWatcher = undefined;
		this.fileWatcher?.close();
		this.fileWatcher = undefined;
	}

	private async start(): Promise<void> {
		this.watchPlanDirectory();
		this.pollTimer = setInterval(() => void this.refresh(false), 1_200);
		await this.refresh(true);
	}

	private watchPlanDirectory(): void {
		const planRoot = path.resolve(this.cwd, PLAN_DIR);
		if (!fs.existsSync(planRoot)) return;
		try {
			this.dirWatcher = fs.watch(planRoot, { persistent: false }, () => void this.refresh(true));
		} catch {
			this.dirWatcher = undefined;
		}
	}

	private setWatchedFile(filePath: string | undefined): void {
		const absolute = filePath ? path.resolve(this.cwd, filePath) : undefined;
		if (absolute === this.sourcePath) return;
		this.fileWatcher?.close();
		this.fileWatcher = undefined;
		this.sourcePath = absolute;
		if (!absolute || !fs.existsSync(absolute)) return;
		try {
			this.fileWatcher = fs.watch(absolute, { persistent: false }, () => void this.refresh(true));
		} catch {
			this.fileWatcher = undefined;
		}
	}

	private async refresh(force: boolean): Promise<void> {
		if (this.disposed) return;
		if (this.refreshing) {
			this.refreshAgain = this.refreshAgain || force;
			return;
		}
		this.refreshing = true;

		try {
			if (!this.sourcePath || !fs.existsSync(this.sourcePath)) {
				const discovered = await findTodoJsonlFile(this.cwd);
				if (discovered) this.setWatchedFile(discovered);
			}

			if (!this.sourcePath) {
				this.loading = false;
				this.snapshot = undefined;
				this.error = undefined;
				this.publishSnapshot();
				this.tui.requestRender();
				return;
			}

			let stat: fs.Stats;
			try {
				stat = await fsp.stat(this.sourcePath);
			} catch {
				this.loading = false;
				this.error = `waiting for ${relativeDisplayPath(this.cwd, this.sourcePath)}`;
				this.snapshot = undefined;
				this.publishSnapshot();
				this.tui.requestRender();
				return;
			}

			if (!force && this.snapshot?.path === this.sourcePath && this.snapshot.mtimeMs === stat.mtimeMs) return;

			const snapshot = await readTodoJsonlFile(this.sourcePath, this.cwd);
			this.loading = false;
			this.snapshot = snapshot;
			this.error = snapshot.errors.length > 0 ? snapshot.errors.slice(0, 2).join(" · ") : undefined;
			this.publishSnapshot();
			this.tui.requestRender();
		} catch (error) {
			this.loading = false;
			this.error = error instanceof Error ? error.message : String(error);
			this.tui.requestRender();
		} finally {
			this.refreshing = false;
			if (this.refreshAgain) {
				const again = this.refreshAgain;
				this.refreshAgain = false;
				void this.refresh(again);
			}
		}
	}

	private publishSnapshot(): void {
		this.onSnapshotChange(this.snapshot);
		this.onLayoutChange(preferredTodoSidebarLayout(this.snapshot));
		if (todoWorkflowActive && this.snapshot && this.snapshot.todos.length > 0 && this.snapshot.todos.every((todo) => !isTodoOpen(todo))) {
			todoWorkflowActive = false;
		}
	}

	private renderTimeline(width: number, snapshot: ParsedTodoFile): string[] {
		const th = this.theme;
		const todos = snapshot.todos;
		const current = currentTodoIndex(todos);
		const allDone = current >= todos.length;
		const timelineBudget = clamp(Math.floor((this.tui.terminal.rows || 30) * 0.7) - 10, 6, 16);
		const beforeBudget = allDone ? Math.min(timelineBudget, 9) : Math.max(1, Math.min(7, Math.floor((timelineBudget - 2) / 2)));
		const beforeStart = Math.max(0, current - beforeBudget);
		const before = todos.slice(beforeStart, current);
		const afterBudget = Math.max(0, timelineBudget - before.length - (allDone ? 0 : 1));
		const after = allDone ? [] : todos.slice(current + 1, current + 1 + afterBudget);
		const lines: string[] = [];

		if (beforeStart > 0) {
			lines.push(this.timelineOverflowRow(width, beforeStart, "earlier"));
		}
		for (const todo of before) lines.push(this.timelineTodoRow(width, todo, false));
		if (before.length > 0 || beforeStart > 0) lines.push(this.blank(width));

		lines.push(this.nowRule(width, allDone));
		lines.push(this.blank(width));

		if (!allDone) {
			lines.push(this.timelineTodoRow(width, todos[current]!, true));
			for (const todo of after) lines.push(this.timelineTodoRow(width, todo, false));
			const remainingAfter = todos.length - (current + 1 + after.length);
			if (remainingAfter > 0) lines.push(this.timelineOverflowRow(width, remainingAfter, "queued"));
		}

		lines.push(this.blank(width));
		lines.push(this.ruleRow(width));
		lines.push(this.blank(width));
		lines.push(...this.logRows(width, snapshot));
		if (this.error) lines.push(this.row(width, ` ${th.fg("warning", truncatePlain(this.error, width - 6))}`));
		return lines;
	}

	private logRows(width: number, snapshot: ParsedTodoFile): string[] {
		const th = this.theme;
		const todos = snapshot.todos;
		const done = todos.filter((todo) => isTodoDone(todo) || isTodoSkipped(todo)).length;
		const blocked = todos.filter(isTodoBlocked).length;
		const active = todos.filter(isTodoActive).length;
		const total = todos.length;
		const started = firstTodoTime(todos);
		const updated = latestTodoTime(todos) ?? snapshot.mtimeMs;
		const planPath = cleanTodoText(todos.find((todo) => todo.planPath)?.planPath) ?? snapshot.relativePath;
		return [
			this.row(width, ` ${th.fg("muted", th.bold("LOG"))}  ${th.fg("dim", "·  todo monitor")}`),
			this.row(width, ` ${th.fg("dim", "started")}   ${formatClock(started)}  ${th.fg("dim", "· ")}${formatElapsed(Date.now() - (started ?? Date.now()))}`),
			this.row(width, ` ${th.fg("dim", "todos")}     ${th.fg("success", String(done))}/${total}  ${th.fg("dim", "· ")}${th.fg(blocked > 0 ? "error" : "warning", `${active} active${blocked ? ` · ${blocked} blocked` : ""}`)}`),
			this.row(width, ` ${th.fg("dim", "updated")}   ${formatClock(updated)}  ${th.fg("dim", "· ")}${th.fg("accent", truncatePlain(path.basename(snapshot.relativePath), Math.max(8, width - 23)))}`),
			this.row(width, ` ${th.fg("dim", "plan")}      ${th.fg("accent", truncatePlain(planPath, Math.max(8, width - 14)))}`),
		];
	}

	private timelineTodoRow(width: number, todo: PlanTodoItem, isCurrent: boolean): string {
		const th = this.theme;
		const time = isCurrent || (!isTodoDone(todo) && !isTodoSkipped(todo)) ? "  ···" : this.todoTimeLabel(todo);
		const timeCol = truncateToWidth(time, 5, "").padEnd(5, " ");
		const glyph = this.todoGlyph(todo, isCurrent);
		const label = this.todoLabel(todo, isCurrent, width);
		return this.row(width, ` ${th.fg("dim", timeCol)} ${th.fg("dim", "│")} ${glyph}  ${label}`);
	}

	private timelineOverflowRow(width: number, count: number, label: string): string {
		return this.row(width, ` ${this.theme.fg("dim", "  …  │")} ${this.theme.fg("dim", `${count} ${label}`)}`);
	}

	private todoTimeLabel(todo: PlanTodoItem): string {
		return formatClock(parseTimestamp(todo.completedAt) ?? parseTimestamp(todo.updatedAt) ?? parseTimestamp(todo.startedAt) ?? parseTimestamp(todo.createdAt));
	}

	private todoGlyph(todo: PlanTodoItem, isCurrent: boolean): string {
		const th = this.theme;
		if (isTodoBlocked(todo)) return th.fg("error", "●");
		if (isTodoDone(todo)) return th.fg("success", "✓");
		if (isTodoSkipped(todo)) return th.fg("muted", "◇");
		if (isCurrent || isTodoActive(todo)) return th.fg("warning", "◐");
		return th.fg("dim", "○");
	}

	private todoLabel(todo: PlanTodoItem, isCurrent: boolean, width: number): string {
		const th = this.theme;
		const highPriority = todo.priority && /^(high|urgent|p0|p1)$/i.test(todo.priority);
		// Size the label from the actual render width instead of the requested overlay width.
		// If pi clamps the overlay, row-level truncation can otherwise wrap/leave stale cells and make the timeline look crooked.
		const maxLabelWidth = Math.max(6, width - 15);
		const text = truncatePlain(`${highPriority ? "! " : ""}${todo.title}`, maxLabelWidth);
		if (isTodoBlocked(todo)) return th.fg("error", text);
		if (isTodoDone(todo) || isTodoSkipped(todo)) return th.fg("muted", text);
		if (isCurrent || isTodoActive(todo)) return th.fg("text", th.bold(text));
		return th.fg("dim", text);
	}

	private nowRule(width: number, allDone: boolean): string {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const label = allDone ? th.fg("success", th.bold("DONE")) : th.fg("accent", th.bold("NOW"));
		const stamp = th.fg("dim", formatClock());
		const core = `${th.fg("dim", "─ ─ ─")} ${label} ${stamp}`;
		const fillerWidth = Math.max(0, innerW - visibleWidth(core) - 1);
		const filler = "─ ".repeat(Math.ceil(fillerWidth / 2)).slice(0, fillerWidth);
		return this.row(width, `${core}${filler ? " " + th.fg("dim", filler) : ""}`);
	}

	private ruleRow(width: number): string {
		return this.row(width, ` ${this.theme.fg("dim", "─".repeat(Math.max(1, width - 5)))}`);
	}

	private topBar(width: number): string {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const title = `─ ${th.fg("accent", th.bold("TIMELINE"))} `;
		const rightText = this.snapshot?.todos.length ? formatElapsed(Date.now() - (firstTodoTime(this.snapshot.todos) ?? Date.now())) : "todo";
		const right = ` ${th.fg("dim", rightText)} ─`;
		const dashes = Math.max(1, innerW - visibleWidth(title) - visibleWidth(right));
		return th.fg("border", "╭") + title + th.fg("border", "─".repeat(dashes)) + right + th.fg("border", "╮");
	}

	private botBar(width: number): string {
		return this.theme.fg("border", `╰${"─".repeat(Math.max(1, width - 2))}╯`);
	}

	private maxRenderRows(): number {
		const terminalRows = this.tui.terminal.rows || 30;
		const configuredRows = typeof todoSidebarMaxHeight === "number" ? todoSidebarMaxHeight : Math.floor(terminalRows * 0.9);
		return clamp(Math.min(configuredRows, terminalRows), 8, Math.max(8, terminalRows));
	}

	private blank(width: number): string {
		return this.row(width, "");
	}

	private row(width: number, content: string): string {
		const innerW = Math.max(1, width - 2);
		return this.theme.fg("border", "│") + padAnsi(content, innerW) + this.theme.fg("border", "│");
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done({ type: "close" });
	}
}

async function openTodoSidebar(ctx: ExtensionContext, options: { initialPath?: string; toggle?: boolean } = {}): Promise<void> {
	if (!ctx.hasUI) return;

	if (closeTodoSidebar) {
		if (options.toggle) {
			closeTodoSidebar();
			return;
		}
		if (options.initialPath) activeTodoSidebarPanel?.setSourcePath(options.initialPath);
		return;
	}

	closeFileTreeSidebarIfOpen();

	const initialPath = options.initialPath ?? (await findTodoJsonlFile(ctx.cwd));
	const applyLayout = (layout: { width: number; maxHeight: number }) => {
		todoSidebarWidth = layout.width;
		todoSidebarMaxHeight = layout.maxHeight;
	};

	// Preload once before creating the overlay. Pi currently sizes overlays at creation time,
	// so waiting for the panel's async watcher would leave the first render stuck at the
	// small empty-state size and clip the bottom border.
	let initialSnapshot = latestTodoSnapshot;
	if (initialPath) {
		try {
			initialSnapshot = await readTodoJsonlFile(path.resolve(ctx.cwd, initialPath), ctx.cwd);
			latestTodoSnapshot = initialSnapshot;
		} catch {
			// The watcher inside the panel will surface read errors after the overlay opens.
		}
	}
	applyLayout(preferredTodoSidebarLayout(initialSnapshot));

	try {
		const sidebarPromise = ctx.ui.custom<TodoSidebarResult>(
			(tui, theme, _keybindings, done) => {
				let closed = false;
				const finish = (result: TodoSidebarResult) => {
					if (closed) return;
					closed = true;
					done(result);
				};

				const panel = new TodoSidebarPanel({
					tui,
					theme,
					cwd: ctx.cwd,
					initialPath,
					done: finish,
					onLayoutChange: (layout) => {
						applyLayout(layout);
						tui.requestRender();
					},
					onSnapshotChange: (snapshot) => {
						latestTodoSnapshot = snapshot;
					},
				});
				activeTodoSidebarPanel = panel;
				closeTodoSidebar = () => finish({ type: "close" });
				return panel;
			},
			{
				overlay: true,
				overlayOptions: () => ({
					anchor: "right-center",
					width: todoSidebarWidth,
					minWidth: 32,
					maxHeight: todoSidebarMaxHeight,
					margin: { right: 0 },
					nonCapturing: true,
				}),
				onHandle: (handle) => {
					handle.unfocus();
				},
			},
		);

		void sidebarPromise
			.catch((error) => {
				if (ctx.hasUI) ctx.ui.notify(`Todo sidebar failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			})
			.finally(() => {
				closeTodoSidebar = null;
				activeTodoSidebarPanel = undefined;
			});
	} catch (error) {
		if (ctx.hasUI) ctx.ui.notify(`Todo sidebar failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

function closeTodoSidebarIfOpen(): boolean {
	if (!closeTodoSidebar) return false;
	closeTodoSidebar();
	return true;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let previousTools: string[] | null = null;
	let latestPlanReview: PlanReviewRequest | undefined;
	let pendingPlanReview: PlanReviewRequest | undefined;
	let planReviewInProgress = false;

	pi.registerFlag("plan", {
		description: "Start in plan mode and expose the plan_agent tool",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (planModeEnabled) ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "⏸ plan"));
		else ctx.ui.setStatus("plan-mode", undefined);
	}

	function enterPlanMode(ctx: ExtensionContext, silent = false): void {
		if (!planModeEnabled) previousTools = pi.getActiveTools().filter((tool) => tool !== "plan_agent");
		planModeEnabled = true;
		pi.setActiveTools(PLAN_MODE_TOOLS);
		updateStatus(ctx);
		if (!silent && ctx.hasUI) {
			ctx.ui.notify(`Plan mode enabled. Main tools: ${PLAN_MODE_TOOLS.join(", ")}`, "info");
		}
	}

	function clearPlanReviewState(): void {
		latestPlanReview = undefined;
		pendingPlanReview = undefined;
	}

	function rememberPlanReview(prompt: string, result: PlanAgentRunResult, source: PlanReviewSource): PlanReviewRequest | undefined {
		if (!isPlanAgentRunOk(result)) {
			clearPlanReviewState();
			return undefined;
		}
		const review = createPlanReview(prompt, result, source);
		latestPlanReview = review;
		return review;
	}

	function restorePlanModeState(ctx: ExtensionContext, silent = false): void {
		planModeEnabled = false;
		if (previousTools) pi.setActiveTools(previousTools);
		previousTools = null;
		updateStatus(ctx);
		if (!silent && ctx.hasUI) ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
	}

	async function createPlanExitHandoff(
		review: PlanReviewRequest,
		decision: PlanExitDecision,
	): Promise<PlanExitHandoff> {
		const plan = await readPlanContent(review.absolutePlanPath, MAX_PLAN_HANDOFF_CHARS);
		return {
			id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			decision,
			originalPrompt: review.prompt,
			planPath: review.planPath,
			absolutePlanPath: review.absolutePlanPath,
			todoPath: review.todoPath,
			absoluteTodoPath: review.absoluteTodoPath,
			planContent: plan.error ? `(Could not read plan file: ${plan.error})` : plan.content,
			planContentTruncated: plan.truncated,
			createdAt: new Date().toISOString(),
		};
	}

	async function exitPlanMode(
		ctx: ExtensionContext,
		options: { silent?: boolean; openTodoSidebar?: boolean; initialTodoPath?: string; handoff?: PlanExitHandoff } = {},
	): Promise<void> {
		restorePlanModeState(ctx, options.silent);
		pendingPlanReview = undefined;
		latestPlanReview = undefined;
		if (options.handoff) {
			sendPlanCustomMessage(pi, ctx, {
				customType: PLAN_HANDOFF_CUSTOM_TYPE,
				content: buildPlanHandoffContent(options.handoff),
				display: false,
				details: {
					id: options.handoff.id,
					decision: options.handoff.decision,
					originalPrompt: options.handoff.originalPrompt,
					planPath: options.handoff.planPath,
					todoPath: options.handoff.todoPath,
					createdAt: options.handoff.createdAt,
				},
			});
		}
		if (options.openTodoSidebar !== false) {
			await openTodoSidebar(ctx, { initialPath: options.initialTodoPath ?? options.handoff?.absoluteTodoPath });
		}
	}

	async function displayPlanForExitRequest(ctx: ExtensionContext, review: PlanReviewRequest): Promise<PlanContentRead> {
		const plan = await readPlanContent(review.absolutePlanPath, MAX_PLAN_PREVIEW_CHARS);
		sendPlanCustomMessage(pi, ctx, {
			customType: PLAN_PREVIEW_CUSTOM_TYPE,
			content: buildPlanPreviewContent(review, plan),
			display: true,
			details: {
				id: review.id,
				planPath: review.planPath,
				todoPath: review.todoPath,
				truncated: plan.truncated,
				error: plan.error,
			},
		});
		if (plan.error && ctx.hasUI) ctx.ui.notify(`Could not read plan before exit: ${plan.error}`, "warning");
		return plan;
	}

	async function exitPlanModeWithLatestPlan(
		ctx: ExtensionContext,
		options: { silent?: boolean; openTodoSidebar?: boolean } = {},
	): Promise<void> {
		const review = latestPlanReview;
		if (!review) {
			await exitPlanMode(ctx, options);
			return;
		}
		await displayPlanForExitRequest(ctx, review);
		const handoff = await createPlanExitHandoff(review, "explicit");
		await exitPlanMode(ctx, { ...options, initialTodoPath: review.absoluteTodoPath, handoff });
	}

	async function requestPlanExitDecision(ctx: ExtensionContext, review: PlanReviewRequest): Promise<void> {
		if (planReviewInProgress) return;
		planReviewInProgress = true;
		try {
			await displayPlanForExitRequest(ctx, review);
			if (!ctx.hasUI) {
				sendPlanCustomMessage(pi, ctx, {
					customType: "plan-mode-exit-decision-skipped",
					content: "Plan mode exit decision skipped because no interactive UI is available. Plan mode remains enabled.",
					display: true,
					details: { planPath: review.planPath, todoPath: review.todoPath },
				});
				return;
			}

			const choice = await ctx.ui.select("Plan 已生成，是否退出 plan mode？", [
				PLAN_EXIT_EXECUTE_OPTION,
				PLAN_EXIT_SHELVE_OPTION,
				PLAN_EXIT_REVISE_OPTION,
			]);

			if (choice === PLAN_EXIT_EXECUTE_OPTION) {
				const handoff = await createPlanExitHandoff(review, "execute");
				todoWorkflowActive = true;
				await exitPlanMode(ctx, { initialTodoPath: review.absoluteTodoPath, handoff });
				sendPlanUserMessage(pi, ctx, buildPlanExecuteKickoffPrompt(handoff));
				return;
			}

			if (choice === PLAN_EXIT_SHELVE_OPTION) {
				const handoff = await createPlanExitHandoff(review, "shelve");
				todoWorkflowActive = false;
				await exitPlanMode(ctx, { initialTodoPath: review.absoluteTodoPath, handoff });
				return;
			}

			if (choice === PLAN_EXIT_REVISE_OPTION) {
				const feedback = (await ctx.ui.editor("请输入 plan 修改意见", ""))?.trim() ?? "";
				if (!feedback) {
					ctx.ui.notify("未输入修改意见，继续保持 plan mode。", "info");
					return;
				}
				pendingPlanReview = undefined;
				sendPlanUserMessage(pi, ctx, buildPlanRevisePrompt(review, feedback));
				return;
			}

			ctx.ui.notify("已取消退出 plan mode，继续保持 plan mode。", "info");
		} finally {
			planReviewInProgress = false;
			updateStatus(ctx);
		}
	}

	async function spawnFromCommand(prompt: string, ctx: ExtensionContext, outputPath?: string): Promise<void> {
		clearPlanReviewState();
		try {
			if (ctx.hasUI) ctx.ui.setStatus("plan-agent", ctx.ui.theme.fg("accent", "plan-agent…"));
			const result = await runPlanAgent(ctx, {
				prompt,
				outputPath,
				signal: ctx.signal,
				onStatus: (status) => {
					if (ctx.hasUI) ctx.ui.setStatus("plan-agent", ctx.ui.theme.fg("accent", status));
				},
			});
			pi.sendMessage(
				{
					customType: "plan-agent-result",
					content: formatPlanAgentResult(result),
					display: true,
					details: {
						planPath: result.planPath,
						planExists: result.planExists,
						todoPath: result.todoPath,
						todoExists: result.todoExists,
						exitCode: result.exitCode,
						model: result.model,
						stopReason: result.stopReason,
					},
				},
				{ triggerTurn: false },
			);
			if (ctx.hasUI) {
				const outputsOk = result.planExists && result.todoExists;
				ctx.ui.notify(
					outputsOk
						? `Plan written: ${result.planPath}; todos: ${result.todoPath}`
						: `Plan agent finished but missed required output(s): ${result.planPath}, ${result.todoPath}`,
					outputsOk ? "info" : "warning",
				);
			}
			const review = rememberPlanReview(prompt, result, "command");
			if (result.todoExists) await openTodoSidebar(ctx, { initialPath: result.absoluteTodoPath });
			if (review) await requestPlanExitDecision(ctx, review);
		} catch (error) {
			clearPlanReviewState();
			const message = error instanceof Error ? error.message : String(error);
			pi.sendMessage(
				{ customType: "plan-agent-result", content: `Plan agent failed: ${message}`, display: true },
				{ triggerTurn: false },
			);
			if (ctx.hasUI) ctx.ui.notify(`Plan agent failed: ${message}`, "error");
		} finally {
			if (ctx.hasUI) ctx.ui.setStatus("plan-agent", undefined);
			updateStatus(ctx);
		}
	}

	pi.registerCommand("plan", {
		description: "Enter plan mode; optionally spawn plan-agent: /plan <request>, /plan off",
		handler: async (args, ctx) => {
			const raw = args.trim();
			if (/^(off|exit|disable|stop)$/i.test(raw)) {
				await exitPlanModeWithLatestPlan(ctx);
				return;
			}

			if (/^status$/i.test(raw)) {
				ctx.ui.notify(planModeEnabled ? "Plan mode is enabled." : "Plan mode is disabled.", "info");
				return;
			}

			await ctx.waitForIdle();
			enterPlanMode(ctx);

			let prompt = raw.replace(/^spawn\s+/i, "").trim();
			if (!prompt && ctx.hasUI) {
				const choice = await ctx.ui.select("Plan mode enabled", [
					"Spawn plan-agent now",
					"Just enter plan mode",
					"Exit plan mode",
				]);
				if (choice === "Exit plan mode") {
					await exitPlanModeWithLatestPlan(ctx);
					return;
				}
				if (choice === "Spawn plan-agent now") {
					const entered = await ctx.ui.editor("What should plan-agent plan?", "");
					prompt = entered?.trim() ?? "";
				}
			}

			if (prompt) await spawnFromCommand(prompt, ctx);
		},
	});

	pi.registerCommand("todo", {
		description: "Toggle todo sidebar or start todo-driven work: /todo <goal>, /todo off",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = [
				{ value: "off", label: "off", description: "close the todo sidebar" },
				{ value: "show", label: "show", description: "open the latest .plan/*.jsonl todo sidebar" },
				{ value: "status", label: "status", description: "show the active todo file" },
			];
			const matches = items.filter((item) => item.value.startsWith(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();

			if (/^(off|close|hide|stop)$/i.test(raw)) {
				todoWorkflowActive = false;
				if (!closeTodoSidebarIfOpen() && ctx.hasUI) ctx.ui.notify("Todo sidebar is not open.", "info");
				return;
			}

			if (/^(show|open)$/i.test(raw)) {
				await openTodoSidebar(ctx);
				return;
			}

			if (/^status$/i.test(raw)) {
				const discovered = await findTodoJsonlFile(ctx.cwd);
				const file = latestTodoSnapshot?.relativePath ?? (discovered ? relativeDisplayPath(ctx.cwd, discovered) : undefined);
				ctx.ui.notify(file ? `Todo sidebar: ${file}` : "No .plan/*.jsonl todo file found.", "info");
				return;
			}

			if (!raw) {
				await openTodoSidebar(ctx, { toggle: true });
				return;
			}

			await ctx.waitForIdle();
			if (planModeEnabled) {
				restorePlanModeState(ctx, true);
				clearPlanReviewState();
			}
			sendPlanCustomMessage(pi, ctx, {
				customType: PLAN_CONTEXT_RESET_CUSTOM_TYPE,
				content: "Starting a new /todo workflow. Ignore any earlier plan-mode handoff context.",
				display: false,
				details: { reason: "todo-command", goal: raw, createdAt: new Date().toISOString() },
			});
			await fsp.mkdir(path.resolve(ctx.cwd, PLAN_DIR), { recursive: true });
			todoWorkflowActive = true;
			await openTodoSidebar(ctx);
			sendPlanUserMessage(pi, ctx, buildTodoCommandPrompt(raw));
		},
	});

	pi.registerShortcut("ctrl+shift+t", {
		description: "Toggle the right-side todo timeline sidebar",
		handler: async (ctx) => {
			await openTodoSidebar(ctx, { toggle: true });
		},
	});

	pi.registerTool({
		name: "plan_agent",
		label: "Plan Agent",
		description:
			"Spawn the global plan-agent in an isolated pi process. It can read the current repo and write/edit/delete only under .plan/.",
		promptSnippet: "Spawn plan-agent to research the repo/web and write a markdown plan plus .plan/todo.jsonl todos under .plan/.",
		promptGuidelines: [
			"Use plan_agent in plan mode when the user asks for a written implementation plan or when a planning task needs isolated research.",
			"The plan_agent tool writes markdown plans and .plan/todo.jsonl todos only under .plan/ and should not be used for implementation.",
			"After plan_agent succeeds, the parent plan-mode extension will display the plan, ask the user whether to execute, shelve, or revise it, and prune context to the original prompt plus plan when exit is approved.",
			"If the user asks to revise the plan after review, call plan_agent again with the same outputPath and do not implement until the parent extension exits plan mode.",
		],
		parameters: PlanAgentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "Plan mode is not enabled. Ask the user to run /plan first." }],
					details: { enabled: false },
				};
			}

			clearPlanReviewState();
			const result = await runPlanAgent(ctx, {
				prompt: params.prompt,
				outputPath: params.outputPath,
				signal,
				onStatus: (status) =>
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { status },
					}),
			});

			const review = rememberPlanReview(params.prompt, result, "tool");
			pendingPlanReview = review;
			if (result.todoExists) await openTodoSidebar(ctx, { initialPath: result.absoluteTodoPath });

			return {
				content: [{ type: "text", text: formatPlanAgentResult(result) }],
				details: {
					planPath: result.planPath,
					planExists: result.planExists,
					todoPath: result.todoPath,
					todoExists: result.todoExists,
					exitCode: result.exitCode,
					model: result.model,
					stopReason: result.stopReason,
					exitReviewPending: Boolean(review),
				},
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return undefined;

		if (event.toolName === "write" || event.toolName === "edit") {
			return { block: true, reason: "Plan mode is read-only. Use plan_agent to write plans under .plan/." };
		}

		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			const check = isReadOnlyBash(command, ctx.cwd);
			if (!check.ok) {
				return {
					block: true,
					reason: `Plan mode blocked bash command: ${check.reason}. Use read/grep/find/ls or plan_agent.`,
				};
			}
		}

		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const review = pendingPlanReview;
		if (!review || !planModeEnabled) return;
		pendingPlanReview = undefined;
		await requestPlanExitDecision(ctx, review);
	});

	pi.on("context", async (event) => {
		const shouldDropPlanUiMessage = (customType: unknown): boolean =>
			customType === "plan-mode-context" ||
			customType === PLAN_PREVIEW_CUSTOM_TYPE ||
			customType === PLAN_CONTEXT_RESET_CUSTOM_TYPE ||
			customType === "plan-mode-exit-decision-skipped";

		if (planModeEnabled) {
			return {
				messages: event.messages.filter((message) => {
					const customType = (message as any).customType;
					if (customType === "todo-sidebar-context" || customType === PLAN_HANDOFF_CUSTOM_TYPE) return false;
					return !shouldDropPlanUiMessage(customType);
				}),
			};
		}

		let lastHandoffIndex = -1;
		let lastResetIndex = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const customType = (event.messages[i] as any).customType;
			if (lastHandoffIndex < 0 && customType === PLAN_HANDOFF_CUSTOM_TYPE) lastHandoffIndex = i;
			if (lastResetIndex < 0 && customType === PLAN_CONTEXT_RESET_CUSTOM_TYPE) lastResetIndex = i;
			if (lastHandoffIndex >= 0 && lastResetIndex >= 0) break;
		}

		const startIndex = lastHandoffIndex >= 0 && lastHandoffIndex > lastResetIndex ? lastHandoffIndex : lastResetIndex >= 0 ? lastResetIndex + 1 : 0;
		const scopedMessages = startIndex > 0 ? event.messages.slice(startIndex) : event.messages;
		const keepTodoContext = (todoWorkflowActive || Boolean(closeTodoSidebar)) && Boolean(todoSnapshotContext(latestTodoSnapshot));
		let lastTodoContextIndex = -1;
		if (keepTodoContext) {
			for (let i = scopedMessages.length - 1; i >= 0; i--) {
				if ((scopedMessages[i] as any).customType === "todo-sidebar-context") {
					lastTodoContextIndex = i;
					break;
				}
			}
		}
		return {
			messages: scopedMessages.filter((message, index) => {
				const customType = (message as any).customType;
				if (shouldDropPlanUiMessage(customType)) return false;
				if (customType === "todo-sidebar-context") return keepTodoContext && index === lastTodoContextIndex;
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode. Do not implement or modify project files from the main agent.

Allowed main-agent actions:
- Inspect the current repository with read, grep, find, ls, and read-only bash.
- Ask clarifying questions.
- Spawn the isolated plan-agent with the plan_agent tool.

Use plan_agent when the user wants a written plan. plan-agent receives the user's prompt, the parent system prompt, repository AGENTS/CLAUDE context, web search via plan_web_search, code searching/checking tools, and write/edit/delete permission only under .plan/. It must write both the markdown plan and .plan/todo.jsonl todos.

After plan_agent succeeds, the parent plan-mode extension will show the plan content, ask the user to choose execute / shelve / revise, and only exit plan mode after user approval. On approved exit, future LLM context is pruned to a handoff containing the user's original prompt and the plan.

If you call plan_agent, pass the user's request as the prompt. Do not use edit/write directly in plan mode. If the user requests revision, call plan_agent again with the same outputPath; do not implement until plan mode exits.`,
					display: false,
				},
			};
		}

		const todoContext = todoWorkflowActive || closeTodoSidebar ? todoSnapshotContext(latestTodoSnapshot) : undefined;
		if (!todoContext) return undefined;
		return {
			message: {
				customType: "todo-sidebar-context",
				content: todoContext,
				display: false,
			},
		};
	});

	pi.on("session_shutdown", async () => {
		closeTodoSidebarIfOpen();
		latestTodoSnapshot = undefined;
		todoWorkflowActive = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			enterPlanMode(ctx, true);
		} else {
			// Keep plan_agent out of the normal tool set; /plan enables it explicitly.
			const activeTools = pi.getActiveTools();
			if (activeTools.includes("plan_agent")) pi.setActiveTools(activeTools.filter((tool) => tool !== "plan_agent"));
			updateStatus(ctx);
		}
	});
}
