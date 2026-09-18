# Changelog

## 2.1.0 (2026-09-13)

### Added

- Parallel tool execution: same-turn tool calls run concurrently with results
  re-joined in model order.
- **Multi-harness communication**: environments get a file-backed mailbox;
  agents message peers via `agent_send`/`agent_inbox` (declared with
  `--peers`), humans via `skillenv mail send/list/read/delete`. Two-agent
  coordination is covered by a deterministic e2e test and live runs.
- **Subagent delegation**: `delegate_task` runs focused subtasks in a fully
  isolated sub-run (no recursion, persisted audit session) and returns the
  report to the parent agent.
- **Cost tracking**: per-model pricing table; sessions accumulate estimated
  USD, shown after each turn and in `session list`.
- REPL `/commit`: stage all + commit with a model-drafted conventional
  commit message.
- **MCP client**: mount external tool servers over stdio JSON-RPC
  (`skillenv mcp add/list/remove/test`; Claude Code compatible
  `~/.skillenv/mcp.json`). Tools appear as `mcp__<server>__<tool>` and merge
  into the toolbox (allowlist aware). Failing servers are skipped.
- **Checkpoints & undo**: file mutations are snapshotted before write/edit;
  REPL `/undo` steps back. `--plan` restricts the agent to read-only tools
  for planning-only runs.
- **Pantheon round-table GUI** (`skillenv pantheon`): local web client where
  each god is a fully isolated harness (own environment, provider
  credentials, sessions, memory, mailbox, persona). Round-table mode streams
  all gods' answers in parallel, runs optional debate rounds where every god
  sees the others' answers, and the chair synthesizes a conclusion; solo
  mode chats with one god. Zero-config: missing default gods are
  auto-provisioned; per-god provider overrides via
  `SKILLENV_GOD_<NAME>_*` env vars.
- **Cross-machine mail sync**: `skillenv mail sync <git-url>` two-way
  syncs every environment's mailbox over a plain git remote (outbox model —
  messages addressed to remote peers are exported exactly once; imports land
  in the matching local environment).
- `skillenv mail prune <env> [--days N] [--all]`: delete old read (and
  optionally unread) messages.
- **Read receipts**: `agent_inbox` automatically acknowledges unread peer
  messages with a receipt; receipts never generate receipts (no loops).
- Anthropic provider: native Messages protocol support (Claude models) with
  full tool streaming — request/response translated to the agent's
  OpenAI-shaped internal loop.
- Provider reliability for the agent: transient failures (network errors,
  HTTP 429/5xx) retry with exponential backoff; `--fallback-provider` /
  `--fallback-model` move the request to a second provider when the primary
  exhausts retries before any output streamed. Partial output is never
  duplicated.
- `--confirm-shell` human-in-the-loop gate: every `run_command` requires an
  interactive `[y/N]` confirmation.
- `--tools` allowlist to restrict the agent toolbox.
- Graceful iteration-limit wrap-up: at `--max-iterations` the agent emits a
  final tool-less summary (completed / remaining / verification status)
  instead of cutting off mid-task.
- Live end-to-end verification against the DeepSeek API: full coding sessions
  (implement CLI + unittest suite, multi-turn continuation, self-repair) with
  independent result verification.
- `skillenv agent-eval <suite.yaml> <env>`: YAML evaluation suites for the
  agent — per-case tool-sequence, file-existence, and exit-code assertions
  with JSON reports and CI-gating exit codes (see
  `examples/suites/coding.yaml`).
- `pretest` builds dist so e2e tests always exercise the current code.
- Coverage tooling (@vitest/coverage-v8) and unit tests for rendering,
  scaffolds, runner, skill frontmatter, and session markdown export.
- Per-case provider overrides in eval suites (`provider:`/`model:` on a case)
  for A/B model comparison.
- `agent-eval --case <name>` runs a single case; `--max-iterations` sets the
  default cap for cases without their own.
- `doctor`/`env info` parse the manifest adapter with the same YAML reader as
  the manifest module (quoted values and inline comments no longer break
  adapter detection).
- Tool-argument repair: unquoted-key JSON from the model (`{to": "x"}`) is
  repaired before the tool fails; unrepairable arguments echo the original
  text so the model can self-correct.
- Registry source names are validated (`..`, path separators) so the cache
  filename cannot escape `~/.skillenv/registry-cache` — found by an agent
  review round and confirmed by reproduction.
- GitHub skill sources reject path traversal (`..` in repo paths or refs)
  before any download — found during a security-focused review round.
- `edit_file` inserts `$&`-style replacement strings literally (found by an
  independent agent code review; regression test first, then a one-line fix).
- `run_command` survives ENOBUFS: oversized output returns the captured
  partial stdout with a truncation warning instead of failing.
- SSE robustness (found by an agent review round): a final event without a
  trailing newline is parsed instead of dropped; a mid-stream failure after
  partial output never triggers a retry (which would duplicate output).
- Context-overflow resilience: provider "maximum context length" errors now
  trigger an aggressive compaction pass and a single retry before failing.
  (Also fixed: the pre-turn compaction result was computed but never applied
  to the conversation.)
- Persistent memory: `memory_read`/`memory_write` tools backed by
  `memory/MEMORY.md` per environment — the agent accumulates durable facts,
  decisions, and preferences across sessions.
- Cumulative session token usage: `total_usage` tracked per session and shown
  by `session list` / REPL `/sessions`.
- Eval `agent-contains` expectation: assert (case-insensitive) that the
  agent's final answer contains given strings.
- `skillenv session export <env> <id> [-o file]`: Markdown transcript export.
- `skillenv env rename <old> <new>`: move an environment and rewrite its
  manifest name, preserving skills, plugins, lock, and sessions.
- Live end-to-end verification against the DeepSeek API: full coding sessions
  (implement CLI + unittest suite, multi-turn continuation, self-repair) with
  independent result verification.
  (default ~120k chars) have older tool outputs and assistant turns replaced
  with placeholders; roles and tool_call ids are preserved so provider
  pairing stays valid. Disable with `compactChars: 0`.

## 2.0.0 (2026-09-12)

Complete TypeScript rewrite of skillenv (the Python 1.x line remains on the
`main` git history).

### Added

- **Adapter system**: first-class adapter registry — `codex` (`CODEX_HOME`),
  `claude` (`CLAUDE_CONFIG_DIR`), `pi` (`PI_CONFIG_DIR`), `gemini`
  (experimental), `generic` (`SKILLENV_*`). `create --adapter`,
  adapter-aware `run` with default commands, adapter-aware `doctor`.
- **Versioned registry + dependency resolution**: registry entries with
  semver versions and dependency edges; constraint intersection across
  requirers, conflict errors with full chains, topological install order,
  cycle tolerance, unversioned-entry warnings.
- **`skillenv registry publish`**: frontmatter validation
  (name/description/semver version), entry emission or upsert into a
  registry JSON file.
- **Built-in coding agent** (`skillenv agent`): streaming tool-calling loop
  over OpenAI-compatible providers — DeepSeek, Nous Hermes, GLM, OpenAI
  (any `OPENAI_BASE_URL`), Ollama, ModelArts MaaS. Ten workspace tools
  (read/write/edit/list/glob/grep/run_command/web_fetch/skill_list/skill_read)
  with SSRF guard, output caps, and timeout-guarded shell. Sessions persisted
  per environment, resumable (`--session`, `--continue`), inspectable
  (`skillenv session list|show`). Skill catalog + on-demand or inlined
  skill injection.
- **YAML manifests** with backward compatibility for the legacy inline-list
  format.
- npm distribution (`@kobelyww/skillenv`), GitHub Actions CI matrix
  (Node 20/22 × ubuntu/macos) with typecheck, build, tests, and CLI smoke.

### Changed

- Environments are adapter-shaped: `create --adapter` scaffolds the right
  manifest and doctor checks.
- `install` accepts multiple specs and resolves registry names with
  dependencies in one transaction.
- `registry list/show/search` expose versions.
- 115 vitest tests, including end-to-end CLI runs and a mock OpenAI-compatible
  provider server.

### Removed

- The Python package (`uv`/pytest tooling). See the `main` branch history.
