# Changelog

## 2.1.0 (2026-09-12)

### Added

- Parallel tool execution: same-turn tool calls run concurrently with results
  re-joined in model order.
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
- Coverage tooling (@vitest/coverage-v8) and unit tests for rendering,
  scaffolds, runner, skill frontmatter, and session markdown export.
- Per-case provider overrides in eval suites (`provider:`/`model:` on a case)
  for A/B model comparison.
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
