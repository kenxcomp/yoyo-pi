# gr0k-hack extension

`extensions/gr0k-hack/` is the yoyo-pi extension for Grok-style agent status UI, compact built-in tool renderers, and the QA subagent workflow.

The package manifest registers only `./extensions/gr0k-hack/index.ts`; helper modules and bundled prompts in this directory are imported by that entrypoint and are not separate extensions.

## Commands

- `/switch-agentStatus <1-9|v1-v9|0|off|status>` — switch the custom thinking/executing/reading/writing status widget.
- `/qa-agent <question>` — start a Socratic, truth-seeking QA workflow in the current conversation.

## `/qa-agent` workflow

`/qa-agent <question>` waits for the current agent turn to become idle, then injects a workflow prompt with `pi.sendUserMessage()`.

The main agent is instructed to:

1. identify ambiguity, hidden premises, missing definitions, and word-sense issues;
2. ask concise Socratic clarification first when the answer depends on the user's intended meaning, preferably using `single_choice` or `choice_questions`;
3. after clarification, call the `subagent` tool in parallel with three bundled QA agents;
4. synthesize internally, then give a conclusion-first user answer without dumping per-subagent process details unless explicitly asked.

Example:

```text
/qa-agent yazi是什么
```

Expected behavior: the main agent should first ask whether `yazi` means the Yazi TUI file manager, another named thing, the word/animal sense, or whether to cover all plausible meanings. It should only spawn the three QA subagents after that clarification unless the user already asked to cover all meanings.

## Bundled QA agents

Bundled agent markdown lives under this gr0k-hack subdirectory:

```text
extensions/gr0k-hack/agents/
├── qa-knowledge.md      # tools: none
├── qa-web-research.md   # tools: qa_web_search
└── qa-critic.md         # tools: none
```

This structure keeps the QA workflow inside the existing gr0k-hack extension. There is no separate top-level `extensions/qa-agent/` extension.

## Tools

### `subagent`

`subagent` delegates work to specialized agents in isolated child `pi` processes. It supports:

- single mode: `{ "agent": "qa-knowledge", "task": "..." }`
- parallel mode: `{ "tasks": [{ "agent": "qa-knowledge", "task": "..." }, ...] }`
- chain mode: `{ "chain": [{ "agent": "...", "task": "... {previous} ..." }] }`

Agent discovery merges scopes in this order:

1. bundled package agents from `extensions/gr0k-hack/agents/`;
2. user agents from `~/.pi/agent/agents/`;
3. trusted project agents from the nearest `.pi/agents/`.

Later scopes override earlier agents with the same `name`. If a requested agent resolves to a project-local prompt, `subagent` asks for confirmation in the UI by default (`confirmProjectAgents: true`).

Child processes run with JSON mode and no unrelated extension leakage:

```text
pi --mode json -p --no-session --no-extensions -e <current gr0k-hack/index.ts> ...
```

Tool policy is taken from each agent's frontmatter:

- `tools: none` becomes `--no-tools`.
- `tools: qa_web_search` becomes `--tools qa_web_search`.
- omitted `tools` uses the child pi default tool set with only gr0k-hack loaded as an extension.

### `qa_web_search`

`qa_web_search` is a read-only web evidence tool for QA. It accepts `{ query, maxResults? }`, supports abort signals, caps large provider responses, and returns compact snippets plus provider metadata.

Provider behavior:

- If `JINA_API_KEY`, `JINA_AUTH_TOKEN`, or `JINA_READER_API_KEY` is configured, it first tries Jina search.
- If no Jina key is available or Jina fails, it tries DuckDuckGo HTML as a no-key fallback.
- If providers fail or block requests, it returns a clear limitation message instead of pretending web evidence was checked.

`qa-web-research.md` is limited to `qa_web_search`, so the web specialist has a practical web-search-only tool policy. This cannot erase the model's latent knowledge, but the prompt requires evidence-grounded claims and explicit provider limitations.

## Reload and package-cache note

When developing from the worktree, confirm which yoyo-pi path the running Pi session actually loaded. If settings load `npm:yoyo-pi` or a git package cache instead of the worktree, modifying `Repo/yoyo-pi/extensions/gr0k-hack/` is not enough. Reinstall/sync the package or start Pi with the local path, then run `/reload` before testing `/qa-agent`, `subagent`, or `qa_web_search`.
