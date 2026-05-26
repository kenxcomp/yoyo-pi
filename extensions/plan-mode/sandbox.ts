/**
 * Sandbox extension for the child plan-agent process.
 *
 * Enforces:
 * - read/search/list/bash path access only inside the current repository
 * - write/edit only inside .plan/
 * - deletion only through plan_delete, also inside .plan/
 * - web search through plan_web_search (no API key required)
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PLAN_DIR = ".plan";
const MAX_WEB_SEARCH_CHARS = 30_000;

function isInside(child: string, root: string): boolean {
	const relative = path.relative(root, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function resolveInputPath(cwd: string, value: string | undefined): string {
	const cleaned = stripAtPrefix((value || ".").trim());
	return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
}

function realpathIfExists(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch {
		return path.resolve(value);
	}
}

function nearestExistingAncestor(value: string): string {
	let current = path.resolve(value);
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

function isPathWithinPolicy(target: string, root: string): boolean {
	const absoluteTarget = path.resolve(target);
	const absoluteRoot = path.resolve(root);
	if (!isInside(absoluteTarget, absoluteRoot)) return false;

	// If the policy root does not exist yet (for example, .plan/ before the
	// first plan is written), allow creation as long as the target and the
	// would-be root share the same safe existing ancestor.
	if (!fs.existsSync(absoluteRoot)) {
		const rootAncestor = nearestExistingAncestor(absoluteRoot);
		const targetAncestor = nearestExistingAncestor(absoluteTarget);
		return isInside(realpathIfExists(targetAncestor), realpathIfExists(rootAncestor));
	}

	const realRoot = realpathIfExists(absoluteRoot);
	const ancestor = nearestExistingAncestor(absoluteTarget);
	const realAncestor = realpathIfExists(ancestor);
	if (!isInside(realAncestor, realRoot)) return false;

	if (fs.existsSync(absoluteTarget)) {
		const realTarget = realpathIfExists(absoluteTarget);
		if (!isInside(realTarget, realRoot)) return false;
	}

	return true;
}

function ensurePlanRootSafe(cwd: string): { ok: boolean; reason?: string } {
	const repoRoot = path.resolve(cwd);
	const planRoot = path.resolve(cwd, PLAN_DIR);
	if (!fs.existsSync(planRoot)) return { ok: true };
	const realRepo = realpathIfExists(repoRoot);
	const realPlan = realpathIfExists(planRoot);
	if (!isInside(realPlan, realRepo)) {
		return { ok: false, reason: `${PLAN_DIR}/ resolves outside the current repo` };
	}
	return { ok: true };
}

function ensureRepoReadPath(cwd: string, rawPath: string | undefined, toolName: string): { ok: boolean; reason?: string } {
	const target = resolveInputPath(cwd, rawPath);
	const repoRoot = path.resolve(cwd);
	if (!isPathWithinPolicy(target, repoRoot)) {
		return { ok: false, reason: `${toolName} path must stay inside current repo: ${rawPath || "."}` };
	}
	return { ok: true };
}

function ensurePlanWritePath(cwd: string, rawPath: string | undefined, toolName: string): { ok: boolean; reason?: string } {
	if (!rawPath?.trim()) return { ok: false, reason: `${toolName} requires a path under ${PLAN_DIR}/` };
	const rootCheck = ensurePlanRootSafe(cwd);
	if (!rootCheck.ok) return rootCheck;
	const target = resolveInputPath(cwd, rawPath);
	const planRoot = path.resolve(cwd, PLAN_DIR);
	if (path.resolve(target) === planRoot) return { ok: false, reason: `Refusing to modify the ${PLAN_DIR}/ directory itself` };
	if (!isPathWithinPolicy(target, planRoot)) {
		return { ok: false, reason: `${toolName} path must stay inside ${PLAN_DIR}/: ${rawPath}` };
	}
	return { ok: true };
}

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	const regex = /"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(command))) tokens.push(match[1] ?? match[2] ?? match[3]);
	return tokens;
}

function looksLikePath(token: string): boolean {
	if (!token || token.startsWith("-")) return false;
	if (/^(https?|ftp):\/\//i.test(token)) return false;
	return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.includes("/");
}

function commandReferencesOutsideRepo(command: string, cwd: string): boolean {
	const repoRoot = path.resolve(cwd);
	for (const token of shellTokens(command)) {
		if (!looksLikePath(token)) continue;
		const cleaned = stripAtPrefix(token.replace(/[,:;]+$/g, ""));
		const target = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
		if (!isPathWithinPolicy(target, repoRoot)) return true;
	}
	return false;
}

const MUTATING_OR_DANGEROUS_BASH = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/<<\s*\w+/, // heredoc
	/\bnpm\s+(install|uninstall|update|ci|link|publish|pack)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bbun\s+(add|remove|install)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick|revert|tag|init|clone|apply|am|bisect)\b/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const READ_ONLY_SEGMENTS = [
	/^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|ps|rg|fd|bat|eza)\b/i,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
	/^\s*yarn\s+(list|info|why|audit)\b/i,
	/^\s*pnpm\s+(list|view|info|why|audit)\b/i,
	/^\s*bun\s+(--version|pm\s+ls)\b/i,
	/^\s*node\s+--version\b/i,
	/^\s*python3?\s+--version\b/i,
	/^\s*jq\b/i,
	/^\s*sed\s+-n\b/i,
	/^\s*awk\b/i,
	/^\s*curl\b/i,
	/^\s*wget\b/i,
];

function isReadOnlyNetworkCommand(segment: string): { ok: boolean; reason?: string } {
	if (/^\s*curl\b/i.test(segment)) {
		if (/\bfile:\/\//i.test(segment)) return { ok: false, reason: "curl file:// URLs are not allowed" };
		if (/\s(-o|-O|-T|--output|--remote-name|--upload-file)\b/i.test(segment)) {
			return { ok: false, reason: "curl output/upload flags are not allowed" };
		}
		if (/\s(-d|--data|--data-raw|--data-binary|-F|--form)\b/i.test(segment)) {
			return { ok: false, reason: "curl request body flags are not allowed" };
		}
		if (/\s-X\s*(POST|PUT|PATCH|DELETE)\b/i.test(segment)) {
			return { ok: false, reason: "mutating curl methods are not allowed" };
		}
	}

	if (/^\s*wget\b/i.test(segment)) {
		if (/\bfile:\/\//i.test(segment)) return { ok: false, reason: "wget file:// URLs are not allowed" };
		if (!/(\s-O\s*-\b|\s--output-document=-\b)/i.test(segment)) {
			return { ok: false, reason: "wget must write to stdout with -O -" };
		}
		if (/\s(-P|--directory-prefix|--mirror|-m|--recursive|-r)\b/i.test(segment)) {
			return { ok: false, reason: "wget download-to-disk flags are not allowed" };
		}
	}

	return { ok: true };
}

function isReadOnlyBash(command: string, cwd: string): { ok: boolean; reason?: string } {
	if (!command.trim()) return { ok: false, reason: "empty command" };
	if (MUTATING_OR_DANGEROUS_BASH.some((pattern) => pattern.test(command))) {
		return { ok: false, reason: "mutating or dangerous command" };
	}
	if (/[`$]\(/.test(command)) return { ok: false, reason: "command substitution is not allowed" };
	if (commandReferencesOutsideRepo(command, cwd)) return { ok: false, reason: "command references a path outside the repo" };

	const segments = command
		.split(/\s*(?:&&|\|\||;|\n|\|)\s*/g)
		.map((segment) => segment.trim())
		.filter(Boolean);

	for (const segment of segments) {
		if (!READ_ONLY_SEGMENTS.some((pattern) => pattern.test(segment))) {
			return { ok: false, reason: `not an allowlisted read-only command: ${segment}` };
		}
		const networkCheck = isReadOnlyNetworkCommand(segment);
		if (!networkCheck.ok) return networkCheck;
	}

	return { ok: true };
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[Truncated ${text.length - maxChars} characters. Refine the query for narrower results.]`;
}

export default function planAgentSandbox(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const rootCheck = ensurePlanRootSafe(ctx.cwd);
		if (rootCheck.ok) await fsp.mkdir(path.resolve(ctx.cwd, PLAN_DIR), { recursive: true });
	});

	pi.registerTool({
		name: "plan_web_search",
		label: "Plan Web Search",
		description: "Search the web for planning/research context. Returns text results; does not write files.",
		promptSnippet: "Search the web for external documentation and research context.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		async execute(_toolCallId, params, signal) {
			const url = `https://s.jina.ai/?q=${encodeURIComponent(params.query)}`;
			const response = await fetch(url, {
				signal,
				headers: {
					Accept: "text/plain, text/markdown;q=0.9, */*;q=0.8",
					"User-Agent": "pi-plan-agent/1.0",
				},
			});
			const text = await response.text();
			if (!response.ok) throw new Error(`plan_web_search failed (${response.status}): ${truncateText(text, 2000)}`);
			return {
				content: [{ type: "text", text: truncateText(`Web search: ${params.query}\n\n${text}`, MAX_WEB_SEARCH_CHARS) }],
				details: { query: params.query, url, status: response.status },
			};
		},
	});

	pi.registerTool({
		name: "plan_delete",
		label: "Plan Delete",
		description: "Delete a file or directory under .plan/. Cannot delete outside .plan/ or the .plan directory itself.",
		parameters: Type.Object({
			path: Type.String({ description: "Path under .plan/ to delete" }),
			recursive: Type.Optional(Type.Boolean({ description: "Delete directories recursively", default: false })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const check = ensurePlanWritePath(ctx.cwd, params.path, "plan_delete");
			if (!check.ok) throw new Error(check.reason);
			const target = resolveInputPath(ctx.cwd, params.path);
			await withFileMutationQueue(target, async () => {
				await fsp.rm(target, { recursive: params.recursive ?? false, force: true });
			});
			return {
				content: [{ type: "text", text: `Deleted ${path.relative(ctx.cwd, target)}` }],
				details: { path: path.relative(ctx.cwd, target), recursive: params.recursive ?? false },
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read") {
			const check = ensureRepoReadPath(ctx.cwd, (event.input as any).path, "read");
			if (!check.ok) return { block: true, reason: check.reason };
		}

		if (event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
			const check = ensureRepoReadPath(ctx.cwd, (event.input as any).path, event.toolName);
			if (!check.ok) return { block: true, reason: check.reason };
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const check = ensurePlanWritePath(ctx.cwd, (event.input as any).path, event.toolName);
			if (!check.ok) return { block: true, reason: check.reason };
		}

		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			const check = isReadOnlyBash(command, ctx.cwd);
			if (!check.ok) {
				return {
					block: true,
					reason: `plan-agent bash blocked: ${check.reason}. Use read/grep/find/ls, plan_web_search, write/edit under .plan/, or plan_delete.`,
				};
			}
		}

		return undefined;
	});
}
