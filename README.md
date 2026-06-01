# skillenv

`skillenv` is a Conda-like environment manager for AI agent skills.

The first release focuses on Codex. Each environment is an isolated `CODEX_HOME`,
so skills, plugins, sessions, logs, and configuration can be separated by task.

## Quick Start

```bash
uv run skillenv create research
uv run skillenv create research-lab --preset research
uv run skillenv create research-lab --preset research --install-plugins
uv run skillenv clone research research-v2
uv run skillenv env list
uv run skillenv env info research
uv run skillenv doctor research
uv run skillenv diff research coding
uv run skillenv install research /path/to/a-skill
uv run skillenv install research pdf
uv run skillenv install research github:openai/skills/skills/.curated/pdf
uv run skillenv plugin install research latex@openai-bundled
uv run skillenv plugin list research
uv run skillenv run research -- codex
uv run skillenv export research > skillenv.yml
uv run skillenv create -f skillenv.yml
uv run skillenv registry list
uv run skillenv registry search notebook
uv run skillenv registry add team ./registry/skills.json
uv run skillenv registry update
uv run skillenv adapter codex --out plugins
uv run skillenv adapter claude-code --out adapters
uv run skillenv remove research
```

During editable development on macOS, if Python skips hidden `.pth` files and
the console script cannot import `skillenv`, use:

```bash
PYTHONPATH=src uv run python -m skillenv --help
```

Each environment lives under:

```text
~/.skillenv/envs/<name>
```

That directory acts as an independent Codex home:

```text
~/.skillenv/envs/research/
  config.toml
  skillenv.yml
  lock.json
  skills/
  plugins/
  sessions/
  log/
```

## Why

Codex skills are useful, but different workflows need different toolboxes.
`skillenv` lets you keep a research environment with PDF, LaTeX, Zotero, and
notebook skills separate from a coding environment with engineering plugins.

## Current Scope

- Create, clone, list, export, import, run, and remove environments.
- Inspect, diagnose, and compare environments with `env info`, `doctor`, and `diff`.
- Install local skill directories containing `SKILL.md`.
- Install bundled registry skills by name, such as `pdf`.
- Install public GitHub skill directories with `github:owner/repo/path@ref`.
- Track installed skills in `lock.json`.
- Create environments from built-in presets: `clean`, `coding`, and `research`.
- Record plugin selectors in environment `config.toml` and `lock.json`.
- Inspect bundled, local, and remote registries.
- Generate Codex and Claude Code adapter scaffolds.
- Run any command with `CODEX_HOME` pointed at a selected environment.

Dependency solving and semantic version constraints are intentionally left for
later releases.

## Presets

```bash
uv run skillenv preset list
uv run skillenv create research-lab --preset research
```

Built-in presets:

- `clean`: no extra skills or plugins.
- `coding`: engineering-oriented starting point.
- `research`: PDF, notebook, LaTeX, Zotero, and transcription-oriented starting point.

Presets write the intended skill/plugin sources into `skillenv.yml`; they do not
automatically install marketplace plugins yet.

To write preset plugin selectors into the environment `config.toml`, use:

```bash
uv run skillenv create research-lab --preset research --install-plugins
```

## Plugins

`skillenv` records plugin selectors in an environment's `config.toml`:

```bash
uv run skillenv plugin install research latex@openai-bundled
uv run skillenv plugin list research
```

This writes:

```toml
[plugins."latex@openai-bundled"]
enabled = true
```

The command does not download plugin cache artifacts itself. It prepares the
isolated Codex home so Codex can load enabled plugin selectors in that
environment.

## Reproducibility

`skillenv install` records installed skills in `lock.json`. `skillenv export`
uses that lock file when available, so another machine can recreate the
environment:

```bash
uv run skillenv export research > skillenv.yml
uv run skillenv create -f skillenv.yml
```

Clone an environment:

```bash
uv run skillenv clone research research-v2
```

`clone` copies skills, plugins, `config.toml`, `lock.json`, and `skillenv.yml`
while rewriting the manifest name. It does not copy `sessions/` or `log/`.

## Inspection

Summarize an environment:

```bash
uv run skillenv env info research
```

Check an environment for common problems:

```bash
uv run skillenv doctor research
```

`doctor` currently verifies core files and checks that every installed skill
directory contains `SKILL.md`.

Compare two environments:

```bash
uv run skillenv diff research coding
```

`diff` compares skills and plugins recorded in each environment lock file.

## Registry

The repository includes a seed registry in:

```text
registry/skills.json
```

The packaged CLI reads the bundled copy and exposes:

```bash
uv run skillenv registry list
uv run skillenv registry show pdf
uv run skillenv registry search notebook
uv run skillenv registry add team ./registry/skills.json
uv run skillenv registry sources
uv run skillenv registry update
```

Registry sources may be local JSON files or HTTP(S) URLs with this shape:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "pdf",
      "source": "github:openai/skills/skills/.curated/pdf",
      "description": "Read, inspect, and create PDF documents."
    }
  ]
}
```

The bundled registry is always available. Added registries are cached under
`~/.skillenv/registry-cache` after `skillenv registry update`. The registry is
metadata, not a full dependency resolver.

## Codex Adapter

Generate a Codex plugin adapter scaffold:

```bash
uv run skillenv adapter codex --out plugins
```

This creates:

```text
plugins/skillenv-codex/
  .codex-plugin/plugin.json
  skills/skillenv/SKILL.md
```

The adapter is intentionally thin. Core behavior stays in the standalone
`skillenv` CLI.

## Claude Code Adapter

Generate a Claude Code skill adapter scaffold:

```bash
uv run skillenv adapter claude-code --out adapters
```

This creates:

```text
adapters/skillenv-claude-code/
  .claude/skills/skillenv/SKILL.md
```

Copy or move the generated `.claude/skills/skillenv` directory into a Claude
Code project, or into your user-level Claude Code skills directory, depending
on how you want to load the adapter.

## Documentation

Project documentation lives in `docs/`:

- `docs/quickstart.md`: first environment setup.
- `docs/adapters.md`: Codex and Claude Code adapter notes.
- `docs/publishing.md`: release and distribution checklist.
- `docs/manifest-spec.md`: `skillenv.yml` format.
- `docs/lockfile-spec.md`: `lock.json` format.

## Open Source Project Files

- `LICENSE`: MIT license.
- `CONTRIBUTING.md`: development and PR guidelines.
- `.github/workflows/ci.yml`: test matrix for Python 3.11, 3.12, and 3.13.
- `.github/workflows/release.yml`: PyPI publishing on version tags.
- `RELEASE.md`: release checklist.
