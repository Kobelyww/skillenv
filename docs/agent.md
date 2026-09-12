# skillenv agent — the built-in coding agent

`skillenv agent` runs a streaming, tool-calling coding agent inside a skillenv
environment. It is a harness: model providers are pluggable presets over the
OpenAI-compatible chat protocol, and the environment's skills shape what the
agent knows how to do.

## Providers

All providers speak `POST {baseUrl}/chat/completions` with `stream: true`.

| Provider | Base URL (default) | API key env | Model env | Default model |
|---|---|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL` | `deepseek-chat` |
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
```

Exit code is non-zero when any case fails, so the suite gates CI the same way
`pytest` does. `--keep-workdirs` preserves each case directory for
inspection. Evaluation runs use a real provider (they exercise the model);
the loop itself is additionally covered by mock-provider e2e tests.

## Testing without a provider

The full loop is covered by tests against a local mock server
(`tests/agent-e2e.test.ts`), so agent behavior is regression-tested in CI
without any API keys.
