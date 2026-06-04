import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type QaAgentScope = "package" | "user" | "project" | "all";
export type QaAgentSource = "package" | "user" | "project";
export type QaAgentToolMode = "default" | "none" | "allowlist";

export interface QaAgentConfig {
	name: string;
	description: string;
	tools?: string[];
	toolMode: QaAgentToolMode;
	model?: string;
	systemPrompt: string;
	source: QaAgentSource;
	filePath: string;
}

export interface QaAgentDiscoveryResult {
	agents: QaAgentConfig[];
	bundledAgentsDir: string;
	userAgentsDir: string;
	projectAgentsDir: string | null;
	scope: QaAgentScope;
}

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_QA_AGENTS_DIR = path.join(EXTENSION_DIR, "agents");

function normalizeScope(scope: string | undefined): QaAgentScope {
	const normalized = (scope || "all").trim().toLowerCase();
	if (["package", "bundled", "bundle", "builtin", "built-in"].includes(normalized)) return "package";
	if (normalized === "user") return "user";
	if (normalized === "project") return "project";
	if (["all", "both", "trusted", "default"].includes(normalized)) return "all";
	return "all";
}

function parseTools(value: string | undefined): { toolMode: QaAgentToolMode; tools?: string[] } {
	const tools = value
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (!tools || tools.length === 0) return { toolMode: "default" };
	if (tools.length === 1 && tools[0]?.toLowerCase() === "none") return { toolMode: "none", tools: [] };
	return { toolMode: "allowlist", tools };
}

function loadAgentsFromDir(dir: string, source: QaAgentSource): QaAgentConfig[] {
	const agents: QaAgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const { toolMode, tools } = parseTools(frontmatter.tools);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools,
			toolMode,
			model: frontmatter.model?.trim() || undefined,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverQaAgents(cwd: string, requestedScope?: string): QaAgentDiscoveryResult {
	const scope = normalizeScope(requestedScope);
	const bundledAgentsDir = BUNDLED_QA_AGENTS_DIR;
	const userAgentsDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const agentMap = new Map<string, QaAgentConfig>();

	// Always seed with bundled package agents unless the caller explicitly asks for project-only.
	// This keeps qa-knowledge/qa-web-research/qa-critic available while still allowing overrides.
	if (scope !== "project") {
		for (const agent of loadAgentsFromDir(bundledAgentsDir, "package")) agentMap.set(agent.name, agent);
	}

	if (scope === "user" || scope === "all") {
		for (const agent of loadAgentsFromDir(userAgentsDir, "user")) agentMap.set(agent.name, agent);
	}

	if ((scope === "project" || scope === "all") && projectAgentsDir) {
		// Project agents intentionally override bundled/user agents only after confirmation in the tool.
		for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()),
		bundledAgentsDir,
		userAgentsDir,
		projectAgentsDir,
		scope,
	};
}

export function formatQaAgentList(agents: QaAgentConfig[], maxItems = 20): string {
	if (agents.length === 0) return "none";
	const listed = agents.slice(0, maxItems);
	const suffix = agents.length > listed.length ? `; +${agents.length - listed.length} more` : "";
	return listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; ") + suffix;
}
