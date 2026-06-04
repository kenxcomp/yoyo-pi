import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const MAX_RESPONSE_CHARS = 80_000;
const MAX_SNIPPET_CHARS = 420;
const JINA_SEARCH_URL = "https://s.jina.ai/";
const DUCKDUCKGO_HTML_URL = "https://duckduckgo.com/html/";

type SearchResult = {
	title: string;
	url?: string;
	snippet: string;
};

type ProviderAttempt = {
	provider: string;
	ok: boolean;
	error?: string;
	resultCount?: number;
};

type SearchResponse = {
	provider: string;
	results: SearchResult[];
	warning?: string;
};

const QaWebSearchParams = Type.Object({
	query: Type.String({ description: "Search query. Be specific and include key terms, names, or dates when relevant." }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum result snippets to return. Default 5, max 10." })),
});

function clampMaxResults(value: unknown): number {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return DEFAULT_MAX_RESULTS;
	return Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.floor(numeric)));
}

function cleanText(value: string): string {
	return decodeHtml(value)
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, maxChars: number): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, Math.max(0, maxChars - 1))}…`;
}

function decodeHtml(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/")
		.replace(/&#(\d+);/g, (_match, code) => {
			const value = Number(code);
			return Number.isFinite(value) ? String.fromCodePoint(value) : "";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
			const value = Number.parseInt(code, 16);
			return Number.isFinite(value) ? String.fromCodePoint(value) : "";
		});
}

function ddgResultUrl(raw: string): string | undefined {
	const decoded = decodeHtml(raw);
	try {
		const url = new URL(decoded, "https://duckduckgo.com");
		const uddg = url.searchParams.get("uddg");
		return uddg || decoded;
	} catch {
		return decoded || undefined;
	}
}

async function fetchText(url: string, options: RequestInit, signal?: AbortSignal): Promise<string> {
	const response = await fetch(url, { ...options, signal });
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	const text = await response.text();
	return text.length <= MAX_RESPONSE_CHARS ? text : text.slice(0, MAX_RESPONSE_CHARS);
}

function parseJinaText(raw: string, maxResults: number): SearchResult[] {
	const text = raw.replace(/\r/g, "").trim();
	if (!text) return [];
	const results: SearchResult[] = [];

	// Jina search output is Markdown-like. Prefer links with following context, but keep a fallback
	// because provider output may change.
	const linkPattern = /(?:^|\n)\s*(?:#{1,4}\s*)?\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)([\s\S]*?)(?=\n\s*(?:#{1,4}\s*)?\[[^\]]+\]\(https?:\/\/|$)/g;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(text)) && results.length < maxResults) {
		const title = cleanText(match[1] || "Untitled result");
		const url = match[2];
		const snippet = truncate(cleanText(match[3] || ""), MAX_SNIPPET_CHARS);
		if (title || snippet) results.push({ title: title || url, url, snippet: snippet || "No snippet returned." });
	}

	if (results.length > 0) return results;

	const paragraphs = text
		.split(/\n{2,}/g)
		.map((part) => cleanText(part))
		.filter(Boolean)
		.slice(0, maxResults);
	return paragraphs.map((snippet, index) => ({ title: `Jina search excerpt ${index + 1}`, snippet: truncate(snippet, MAX_SNIPPET_CHARS) }));
}

function parseDuckDuckGoHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const blockPattern = /<div[^>]+class="[^"]*result[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*result[^"]*"|<\/body>|$)/gi;
	let blockMatch: RegExpExecArray | null;
	while ((blockMatch = blockPattern.exec(html)) && results.length < maxResults) {
		const block = blockMatch[0];
		const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!link) continue;
		const title = cleanText(link[2] || "Untitled result");
		const url = ddgResultUrl(link[1] || "");
		const snippetMatch = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
		const snippet = truncate(cleanText(snippetMatch?.[1] || snippetMatch?.[2] || ""), MAX_SNIPPET_CHARS);
		if (title || snippet) results.push({ title: title || url || "DuckDuckGo result", url, snippet: snippet || "No snippet returned." });
	}
	return results;
}

async function searchWithJina(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const apiKey = process.env.JINA_API_KEY || process.env.JINA_AUTH_TOKEN || process.env.JINA_READER_API_KEY;
	if (!apiKey) throw new Error("JINA_API_KEY/JINA_AUTH_TOKEN is not configured");
	const url = `${JINA_SEARCH_URL}?q=${encodeURIComponent(query)}`;
	const raw = await fetchText(
		url,
		{
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "text/plain, text/markdown;q=0.9, */*;q=0.1",
			},
		},
		signal,
	);
	const results = parseJinaText(raw, maxResults);
	if (results.length === 0) throw new Error("Jina returned no parseable results");
	return { provider: "jina", results };
}

async function searchWithDuckDuckGo(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
	const url = `${DUCKDUCKGO_HTML_URL}?q=${encodeURIComponent(query)}`;
	const html = await fetchText(
		url,
		{
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; yoyo-pi qa_web_search/0.1; +https://github.com/kenxcomp/yoyo-pi)",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		},
		signal,
	);
	const results = parseDuckDuckGoHtml(html, maxResults);
	if (results.length === 0) throw new Error("DuckDuckGo returned no parseable results or blocked the request");
	return { provider: "duckduckgo-html", results };
}

function formatResults(query: string, response: SearchResponse, attempts: ProviderAttempt[]): string {
	const lines = [`qa_web_search results for: ${query}`, `Provider: ${response.provider}`];
	if (response.warning) lines.push(`Warning: ${response.warning}`);
	lines.push("");
	for (let index = 0; index < response.results.length; index++) {
		const result = response.results[index];
		lines.push(`${index + 1}. ${result.title}`);
		if (result.url) lines.push(`   URL: ${result.url}`);
		lines.push(`   Evidence: ${result.snippet}`);
	}
	const failed = attempts.filter((attempt) => !attempt.ok);
	if (failed.length > 0) {
		lines.push("", "Provider notes:");
		for (const attempt of failed) lines.push(`- ${attempt.provider}: ${attempt.error}`);
	}
	return lines.join("\n");
}

function formatFailure(query: string, attempts: ProviderAttempt[]): string {
	const lines = [
		`qa_web_search could not retrieve web results for: ${query}`,
		"This tool is read-only and could not obtain usable evidence from the configured providers.",
		"Configure JINA_API_KEY/JINA_AUTH_TOKEN for the authenticated Jina path, or retry later if DuckDuckGo HTML is blocked/rate-limited.",
		"",
		"Provider attempts:",
	];
	for (const attempt of attempts) lines.push(`- ${attempt.provider}: ${attempt.ok ? "ok" : attempt.error || "failed"}`);
	return lines.join("\n");
}

export function registerQaWebSearchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "qa_web_search",
		label: "QA Web Search",
		description:
			"Read-only web search for QA subagents. Returns compact evidence snippets with provider metadata; does not write files.",
		promptSnippet: "Search the web for compact evidence snippets for factual QA/research claims.",
		promptGuidelines: [
			"Use qa_web_search for current or externally verifiable facts in the gr0k-hack QA workflow.",
			"qa_web_search returns snippets, not proof. Cite provider/source URLs when available and state uncertainty when search providers fail.",
		],
		parameters: QaWebSearchParams,
		async execute(_toolCallId, params: any, signal, onUpdate) {
			const query = String(params.query || "").trim();
			const maxResults = clampMaxResults(params.maxResults);
			if (!query) {
				return {
					content: [{ type: "text", text: "qa_web_search requires a non-empty query." }],
					details: { query, provider: "none", attempts: [], results: [] },
					isError: true,
				};
			}

			const attempts: ProviderAttempt[] = [];
			const startedAt = Date.now();
			const providers: Array<{ name: string; run: () => Promise<SearchResponse> }> = [
				{ name: "jina", run: () => searchWithJina(query, maxResults, signal) },
				{ name: "duckduckgo-html", run: () => searchWithDuckDuckGo(query, maxResults, signal) },
			];

			for (const provider of providers) {
				onUpdate?.({ content: [{ type: "text", text: `Searching ${provider.name} for: ${query}` }], details: { query, provider: provider.name } });
				try {
					const response = await provider.run();
					attempts.push({ provider: provider.name, ok: true, resultCount: response.results.length });
					return {
						content: [{ type: "text", text: formatResults(query, response, attempts) }],
						details: {
							query,
							provider: response.provider,
							attempts,
							results: response.results,
							durationMs: Date.now() - startedAt,
						},
					};
				} catch (error) {
					attempts.push({ provider: provider.name, ok: false, error: error instanceof Error ? error.message : String(error) });
					if (signal?.aborted) break;
				}
			}

			return {
				content: [{ type: "text", text: formatFailure(query, attempts) }],
				details: { query, provider: "none", attempts, results: [], durationMs: Date.now() - startedAt },
			};
		},
		renderCall(args: any, theme) {
			const query = truncateToWidth(String(args.query || "search"), 90, "…", true);
			return new Text(`${theme.fg("toolTitle", theme.bold("qa_web_search"))} ${theme.fg("accent", query)}`, 0, 0);
		},
		renderResult(result: any, _options, theme) {
			const details = result.details as { provider?: string; results?: SearchResult[]; attempts?: ProviderAttempt[] } | undefined;
			const first = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			if (!details) return new Text(first || "(no search result)", 0, 0);
			const count = details.results?.length ?? 0;
			const provider = details.provider || "none";
			const statusColor = count > 0 ? "success" : "warning";
			let text = `${theme.fg(statusColor, count > 0 ? "✓" : "!")} ${theme.fg("toolTitle", theme.bold("qa_web_search"))} ${theme.fg("accent", `${count} result${count === 1 ? "" : "s"}`)} ${theme.fg("dim", `via ${provider}`)}`;
			if (count > 0) {
				for (const item of (details.results || []).slice(0, 3)) {
					text += `\n- ${theme.fg("accent", truncateToWidth(item.title, 80, "…", true))}`;
					if (item.url) text += theme.fg("dim", ` · ${truncateToWidth(item.url, 90, "…", true)}`);
				}
			} else {
				const failures = details.attempts?.map((attempt) => `${attempt.provider}: ${attempt.error || "failed"}`).join("; ");
				text += `\n${theme.fg("warning", truncateToWidth(failures || first || "No provider results", 160, "…", true))}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
