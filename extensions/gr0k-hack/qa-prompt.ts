import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function buildQaAgentPrompt(question: string): string {
	const trimmedQuestion = question.trim();
	return `# gr0k-hack /qa-agent workflow

The user invoked the gr0k-hack QA workflow for this question:

> ${trimmedQuestion}

You are the main orchestrator for a truth-seeking QA process. Do not jump straight to an answer when the question is ambiguous or under-specified.

## Required workflow
1. Restate the likely question and identify ambiguity, hidden premises, missing definitions, or word-sense issues.
2. If the ambiguity could change the answer, ask concise Socratic clarification before spawning subagents. Prefer \`single_choice\` or \`choice_questions\` when the user can choose among clear options. For example, if the question is \`yazi是什么\`, ask whether they mean the Yazi TUI file manager, the word/animal sense, another named thing, or whether they want all plausible meanings.
3. If the user explicitly asks to cover all plausible meanings, or after clarification is sufficient, call \`subagent\` once in parallel with exactly these bundled gr0k-hack QA agents:
   - \`qa-knowledge\`: internal knowledge/reasoning only; no web/tools.
   - \`qa-web-research\`: web-search-only evidence gathering via \`qa_web_search\`; it must search before making factual claims.
   - \`qa-critic\`: no-web critic checking ambiguity, false premises, category errors, weak evidence, contradictions, and overreach.

   Suggested tool shape after clarification:

   \`\`\`json
   {
     "tasks": [
       { "agent": "qa-knowledge", "task": "Answer the clarified question from internal knowledge only. State assumptions and uncertainty." },
       { "agent": "qa-web-research", "task": "Research the clarified question using qa_web_search before factual claims. Return source-backed evidence and uncertainty." },
       { "agent": "qa-critic", "task": "Critique the clarified question and likely answers for ambiguity, false premises, missing definitions, category errors, conflicts, and overclaiming." }
     ],
     "agentScope": "all",
     "confirmProjectAgents": true
   }
   \`\`\`

4. Synthesize the subagent outputs internally. Do not average opinions. Prefer the answer best supported by evidence and logic, and use the critic to remove overclaims.
5. If web search fails or is provider-limited, do not pretend current evidence was checked. Mention the limitation only when it materially changes confidence or the user asked for current/source-backed facts.

## Final answer style
The final user-visible answer should be conclusion-first and concise. Do not expose orchestration details, subagent names, per-agent summaries, tool-call chronology, or “Evidence from X agent” sections unless the user explicitly asks how the answer was derived.

Default structure:
- Direct answer / conclusion first.
- Key reasons or caveats only as needed.
- Practical implications / next steps when helpful.
- Uncertainty only where it affects the answer.

Avoid process-heavy headings like “Evidence from internal-knowledge agent”, “Evidence from web-research agent”, or “Critic / overreach checks”. Treat subagent outputs as internal scratch work, not content to report verbatim.

Begin now with clarification if needed; otherwise proceed to the parallel subagent call and then answer directly.`;
}

export function registerQaAgentCommand(pi: ExtensionAPI): void {
	pi.registerCommand("qa-agent", {
		description: "Run the gr0k-hack Socratic QA workflow with knowledge, web-research, and critic subagents.",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /qa-agent <question>", "warning");
				return;
			}

			await ctx.waitForIdle();
			pi.sendUserMessage(buildQaAgentPrompt(question));
		},
	});
}
