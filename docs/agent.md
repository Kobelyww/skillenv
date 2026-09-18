# skillenv agent — the built-in coding agent

`skillenv agent` runs a streaming, tool-calling coding agent inside a skillenv
environment. It is a harness: model providers are pluggable presets over the
OpenAI-compatible chat protocol, and the environment's skills shape what the
agent knows how to do.

## Providers

All providers speak the OpenAI-compatible `POST {baseUrl}/chat/completions`
with `stream: true`, except `anthropic`, which uses the Anthropic Messages
protocol (`/v1/messages` with `x-api-key`, `system` as a top-level parameter,
and `input_schema` tools) — translated transparently by the harness.

| Provider | Base URL (default) | API key env | Model env | Default model |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-chat` |
| `anthropic` | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude-sonnet-4-5` |
| `nous` | `https://inference-api.nousresearch.com/v1` | `NOUS_API_KEY` | `HERMES_MODEL` | `Hermes-4-405B` |
| `glm` | `https://open.bigmodel.cn/api/paas/v4` | `GLM_API_KEY` | `GLM_MODEL` | `glm-4.6` |
| `openai` | `OPENAI_BASE_URL` (else api.openai.com/v1) | `OPENAI_API_KEY` | `OPENAI_MODEL` | `gpt-5.2` |
| `ollama` | `http://127.0.0.1:11434/v1` | — none | `OLLAMA_MODEL` | `qwen3:8b` |
| `modelarts` | `MODELARTS_BASE_URL` (required) | `MODELARTS_API_KEY` | `MODELARTS_MODEL` | — required |

Selection order for model and base URL: explicit CLI flag → provider env var →
preset default. `SKILLENV_AGENT_PROVIDER` sets the default provider without a
flag.

```bash
skillenv agent research -p deepseek -m deepseek-reasoner --dir ~/project
skillenv agent research -p ollama -m llama3.3          # fully local
skillenv agent research --base-url http://gw.corp/v1 --api-key xxx --model internal-7b
```

## Reliability

- **Retries with backoff**: transient failures (network errors, HTTP 429/5xx)
  are retried up to 3 attempts with exponential backoff (500ms/1s/2s).
  Non-retryable 4xx errors surface immediately.
- **Provider failover**: pass `--fallback-provider <id>` (and
  `--fallback-model`). When the primary provider exhausts its retries *before
  any output was streamed*, the loop moves to the fallback with the same
  retry budget and reports the switch. Once text has reached the terminal, a
  failure propagates instead of retrying, so partial output is never
  duplicated.
- **Iteration-limit wrap-up**: when `--max-iterations` is reached, the agent
  makes one final tool-less request asking the model for a concise summary of
  completed work, remaining work, and verification status — instead of
  cutting off mid-task.
- **Tool allowlist**: `--tools read_file,grep,...` restricts the toolbox for
  security-sensitive runs (e.g. drop `run_command`/`web_fetch`).
- **Context compaction**: conversations exceeding `--compact-chars` (default
  ~120k chars) have older tool outputs and assistant turns replaced with
  placeholders; roles and tool_call ids are preserved so provider pairing
  stays valid. `--compact-chars 0` disables.
- **Shell confirmation**: `--confirm-shell` asks `[y/N]` before every shell
  command (interactive terminals only; see [SECURITY.md](../SECURITY.md)).

## Tools

The agent has ten tools. Paths are relative to `--dir` (default: the current
working directory).

| Tool | Behavior |
|---|---|
| `read_file` | UTF-8 text with 1-based line numbers; `offset`/`limit` for big files |
| `write_file` | Create or overwrite; parent directories are created |
| `edit_file` | Exact substring replace; refuses when `old_string` matches 0 or >1 times |
| `list_dir` | Directory entries, directories marked with `/` |
| `glob` | `*`, `**`, `?`, `[abc]` patterns; skips `node_modules` and `.git`; 200-entry cap |
| `grep` | JavaScript regex over file contents; `include` glob filter; 200-match cap |
| `run_command` | Shell via `sh -c` (POSIX) with 60s default timeout (max 300s); non-zero exits are reported, not fatal |
| `web_fetch` | Public http(s) only; DNS-checked SSRF guard blocks loopback/private/link-local targets; 32 KB cap |
| `skill_list` | Installed skills with their frontmatter descriptions |
| `skill_read` | Full `SKILL.md` of one skill; path traversal rejected |
| `memory_read` | The environment's persistent memory (`memory/MEMORY.md`) |
| `memory_write` | Append a durable fact to persistent memory (one entry per call) |
| `agent_send` | Deliver a message to a peer harness's mailbox (`--peers` declared) |
| `agent_inbox` | Read mailbox messages from peers (unread marked read) |

## Skill injection

The system prompt contains the environment identity, the working directory,
usage guidelines, and — by default — nothing else about skills beyond the
catalog tools. Three ways to bring skills in:

1. **On demand** (default): the agent calls `skill_list`, then `skill_read`
   for a skill it deems relevant.
2. **Inline**: `--skills pdf,latex` pastes those skills' full `SKILL.md` into
   the system prompt — deterministic and costs tokens.
3. **Preset-driven environments**: create task-shaped environments
   (`--preset research`) so the catalog matches the work.

## Persistent memory

The agent keeps durable notes per environment in `memory/MEMORY.md`
(`memory_read`/`memory_write` tools). The system prompt instructs it to check
memory when context may exist and to record durable preferences and lessons —
so a working agent accumulates knowledge instead of starting cold every
session. Memory is plain Markdown, safe to edit by hand, and never synced
anywhere.

## Sessions

Every turn appends to a JSON transcript in `<env>/sessions/agent-<ts>-<rand>.json`:

```bash
skillenv agent research -q "draft the test plan"        # one-shot, session saved
skillenv agent research -c --dir ~/project              # continue the latest session
skillenv agent research -s agent-20260911T...-f3ab      # explicit session
skillenv session list research
skillenv session show research agent-20260911T...-f3ab
```

Interactive mode (`skillenv agent research`) opens a REPL with
`/exit`, `/sessions`, `/skills`. Each turn re-streams tokens and persists
immediately, so a crash never loses more than the current turn.

## Loop behavior

- Max iterations per turn: 25 (override `--max-iterations`).
- The turn ends when the model answers without tool calls.
- Tool failures are returned to the model as error payloads, so it can correct
  itself; only the outer loop bound stops pathological retries.
- Token usage per turn is accumulated from the provider's stream usage chunks
  (providers that support `stream_options.include_usage`).

## MCP integration

Mount external tool servers (Model Context Protocol, stdio transport). The
config lives at `~/.skillenv/mcp.json` in the Claude Code compatible shape;
before every agent turn, configured servers are launched, their tools are
registered as `mcp__<server>__<tool>`, and tool calls are forwarded. A
failing server is skipped with a warning — degraded capability, never an
outage.

```bash
skillenv mcp add fetch -- uvx mcp-server-fetch        # register
skillenv mcp add calc -e KEY=val -- node calc-server.js
skillenv mcp list                                      # inspect
skillenv mcp test fetch                                # handshake + tools/list
skillenv mcp remove fetch
```

Mounted tools appear in `--tools` allowlists by their full names
(`mcp__fetch__fetch`) and are announced to the model automatically.

## Checkpoints and undo

Every `write_file`/`edit_file` snapshots the original file into
`<env>/checkpoints/<session>/` before mutating it (on by default; disable
with `--no-checkpoints`). In the REPL, `/undo` steps back through the
session's mutations — restoring previous contents, or removing files the
agent created.

## Subagent delegation

`delegate_task` (on by default; `--no-delegate` disables) spawns a fresh,
fully isolated sub-run for a focused subtask: new context, no delegate tool
(recursion impossible), its own persisted session for audit. Put everything
the subagent needs into `goal`/`context` — it cannot see your conversation.

## Cost tracking

Token usage is priced per model (built-in table: DeepSeek, Claude, GPT,
Gemini, GLM) and accumulated per session. Every turn ends with an
`iterations · tool calls · tokens · $cost` line, and `session list` shows
cumulative USD. Unknown models track tokens at $0.

## Git integration

REPL `/commit <message>` stages all changes and commits locally (never
pushes). Without a message, the model drafts a conventional-commit line from
the diff stat.

## Plan mode

`skillenv agent <env> --plan` restricts the toolbox to read-only tools and
instructs the agent to produce an implementation plan instead of changes —
safe exploration of an unfamiliar codebase, executed separately afterwards.

## Multi-harness communication

Launch several agents and let them coordinate over a file-backed message bus:

```bash
# Terminal 1 — worker hands off to a reviewer
skillenv agent worker --peers reviewer --dir ~/proj -q "Implement the fix, then agent_send a summary to reviewer."

# Terminal 2 — reviewer picks up the handoff
skillenv agent reviewer --peers worker --dir ~/proj -q "Check agent_inbox, review the change, agent_send your verdict."
```

- Mailboxes live at `<env>/mailbox/` — one JSON file per message
  (from/to/subject/body/read), no server involved.
- `--peers env1,env2` declares which environments the agent can message;
  peers are announced in the system prompt. A peer whose environment does
  not exist locally is treated as remote: messages land in the outbox.
- Humans share the bus: `skillenv mail send/list/read/delete <env> …`.
- Keep `agent_send` bodies a single JSON string — malformed arguments are
  repaired (jsonrepair) or echoed back so the model can retry.

### Cross-machine sync

```bash
skillenv mail sync git@github.com:me/mailbus.git     # or a local bare repo path
```

Two-way sync of **all** environment mailboxes over a plain git remote
(working checkout under `~/.skillenv/mailbus`). Messages addressed to a peer
environment are exported into `bus/<peer>/` exactly once (`synced` flag);
each machine's sync imports what is addressed to its own environments.
Message files are unique, so concurrent machines merge without conflicts.
Run it from cron or before/after agent sessions.

### Housekeeping

```bash
skillenv mail prune <env>                # delete read messages older than 30 days
skillenv mail prune <env> --days 7 --all # including unread
```

## Evaluation suites

`skillenv agent-eval` regression-tests agent behavior the way a unit suite
regression-tests code: each case runs the real loop in a fresh workdir, then
asserts on the tool sequence, produced files, and verification commands.

```yaml
# examples/suites/coding.yaml
name: coding-basics
cases:
  - name: implement-and-verify
    prompt: >-
      Create add.py ... run the tests and make sure they pass.
    max-iterations: 12
    expect:
      tools-used: [write_file, run_command]
      files-exist: [add.py, test_add.py]
      command: ["python3", "test_add.py"]
```

```bash
skillenv agent-eval examples/suites/coding.yaml my-env --report report.json
skillenv agent-eval examples/suites/coding.yaml my-env --case implement-and-verify   # one case only
```

A case may override the provider for A/B model comparison:

```yaml
  - name: same-task-on-claude
    prompt: >-
      Create add.py ...
    provider: anthropic
    model: claude-sonnet-4-5
```

Exit code is non-zero when any case fails, so the suite gates CI the same way
`pytest` does. `--keep-workdirs` preserves each case directory for
inspection. Evaluation runs use a real provider (they exercise the model);
the loop itself is additionally covered by mock-provider e2e tests.

## Testing without a provider

The full loop is covered by tests against a local mock server
(`tests/agent-e2e.test.ts`), so agent behavior is regression-tested in CI
without any API keys.

## Pantheon — the round-table GUI

`skillenv pantheon` starts a local web client (`http://127.0.0.1:4620`)
where every god is a **fully isolated harness**: its own skillenv
environment (skills, sessions, memory, mailbox), its own provider
credentials, and its own persona. The server only orchestrates — harnesses
share nothing except answers deliberately passed between them.

```bash
skillenv pantheon                                    # hermes/athena/hephaestus auto-provisioned
skillenv pantheon -g hermes -g poseidon -p nous      # custom roster, Hermes models
skillenv pantheon --persona "hermes=You are..." -p deepseek
```

Modes:

- **圆桌 (round table)**: your prompt streams to every god in parallel;
  each god answers with its own tools and memory; in debate rounds every
  god sees the others' answers and responds; the chair (first god)
  synthesizes a final recommendation.
- **单神 (solo)**: a private audience with one god — same isolation.

Per-god provider isolation: set `SKILLENV_GOD_HERMES_PROVIDER=nous`,
`SKILLENV_GOD_HERMES_MODEL=Hermes-4-405B`, `SKILLENV_GOD_ATHENA_*`, … and
each god runs on different credentials/models while sharing nothing.
