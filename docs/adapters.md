# Adapters

An adapter teaches skillenv how one agent CLI consumes an isolated home: which
environment variable redirects its config directory, what command `skillenv
run` launches by default, and which files a healthy environment requires.

## Supported adapters

| Adapter | Isolation variable | Default command | Required files | Status |
|---|---|---|---|---|
| `codex` | `CODEX_HOME` | `codex` | `config.toml` | Fully supported |
| `claude` | `CLAUDE_CONFIG_DIR` | `claude` | — | Fully supported |
| `pi` | `PI_CONFIG_DIR` | `pi` | — | Best effort |
| `gemini` | — | `gemini` | — | Experimental |
| `generic` | — | — (must pass a command) | — | Stable |

List them from the CLI: `skillenv adapter list`.

## What run does

`skillenv run <env> [-- command...]` exports, on top of your current shell
environment:

```text
SKILLENV_ENV=<env name>
SKILLENV_ENV_ROOT=<environment root>
SKILLENV_SKILLS_DIR=<environment root>/skills
```

plus the adapter's isolation variable (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`PI_CONFIG_DIR`) when it defines one. With no command after `--`, the
adapter's default command runs.

## Codex

`CODEX_HOME` is fully redirected to the environment root, so config, history,
and skills all live inside it. Plugin selectors are recorded by
`skillenv plugin install` as `[plugins."<selector>"]` blocks in the
environment's `config.toml`:

```bash
skillenv create codex-research --adapter codex
skillenv plugin install codex-research latex@openai-bundled
skillenv run codex-research
```

## Claude Code

`CLAUDE_CONFIG_DIR` redirects Claude Code's user-level config. Skills
installed with `skillenv install` land in `<env>/skills/`, which Claude Code
reads as user-level skills, so installed skills appear automatically:

```bash
skillenv create cc --adapter claude
skillenv install cc github:openai/skills/skills/.curated/pdf
skillenv run cc -- claude
```

## pi

`PI_CONFIG_DIR` points at the environment root (best effort; verify against
your pi version).

## Gemini (experimental)

gemini-cli currently has no config-directory override, so the gemini adapter
exports only the generic `SKILLENV_*` variables. Treat it as a scaffold until
an override ships.

## Generic

For any other agent CLI:

```bash
skillenv create ops --adapter generic
skillenv install ops ./skills/runbook
skillenv run ops -- my-agent --skills "$SKILLENV_SKILLS_DIR"
```

## Adapter artifacts

Generate skills that teach the host agent how to drive skillenv itself:

```bash
skillenv adapter codex -o plugins        # Codex plugin scaffold
skillenv adapter claude-code -o adapters # Claude Code skill scaffold
skillenv adapter pi -o adapters          # pi skill scaffold
skillenv adapter gemini -o adapters      # Gemini skill scaffold
```
