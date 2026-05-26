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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
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

function formatPlanAgentResult(result: PlanAgentRunResult): string {
	const processOk = result.exitCode === 0 && !result.errorMessage && result.stopReason !== "error" && result.stopReason !== "aborted";
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

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let previousTools: string[] | null = null;

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

	function exitPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		if (previousTools) pi.setActiveTools(previousTools);
		previousTools = null;
		updateStatus(ctx);
		if (ctx.hasUI) ctx.ui.notify("Plan mode disabled. Previous tools restored.", "info");
	}

	async function spawnFromCommand(prompt: string, ctx: ExtensionContext, outputPath?: string): Promise<void> {
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
		} catch (error) {
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
				exitPlanMode(ctx);
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
					exitPlanMode(ctx);
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

	pi.registerTool({
		name: "plan_agent",
		label: "Plan Agent",
		description:
			"Spawn the global plan-agent in an isolated pi process. It can read the current repo and write/edit/delete only under .plan/.",
		promptSnippet: "Spawn plan-agent to research the repo/web and write a markdown plan plus .plan/todo.jsonl todos under .plan/.",
		promptGuidelines: [
			"Use plan_agent in plan mode when the user asks for a written implementation plan or when a planning task needs isolated research.",
			"The plan_agent tool writes markdown plans and .plan/todo.jsonl todos only under .plan/ and should not be used for implementation.",
		],
		parameters: PlanAgentParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!planModeEnabled) {
				return {
					content: [{ type: "text", text: "Plan mode is not enabled. Ask the user to run /plan first." }],
					details: { enabled: false },
				};
			}

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

	pi.on("context", async (event) => {
		if (planModeEnabled) return undefined;
		return {
			messages: event.messages.filter((message) => (message as any).customType !== "plan-mode-context"),
		};
	});

	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return undefined;
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

If you call plan_agent, pass the user's request as the prompt. Do not use edit/write directly in plan mode.`,
				display: false,
			},
		};
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
