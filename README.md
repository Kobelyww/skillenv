# skillenv

`skillenv` is a Conda-like environment manager for AI agent skills.

The first release focuses on Codex. Each environment is an isolated `CODEX_HOME`,
so skills, plugins, sessions, logs, and configuration can be separated by task.

## Quick Start

```bash
uv run skillenv create research
uv run skillenv create research-lab --preset research
uv run skillenv env list
uv run skillenv install research /path/to/a-skill
uv run skillenv install research github:openai/skills/skills/.curated/pdf
uv run skillenv run research -- codex
uv run skillenv export research > skillenv.yml
uv run skillenv create -f skillenv.yml
uv run skillenv registry list
uv run skillenv adapter codex --out plugins
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

- Create, list, export, import, run, and remove environments.
- Install local skill directories containing `SKILL.md`.
- Install public GitHub skill directories with `github:owner/repo/path@ref`.
- Track installed skills in `lock.json`.
- Create environments from built-in presets: `clean`, `coding`, and `research`.
- Inspect the bundled seed registry.
- Generate a Codex plugin adapter scaffold.
- Run any command with `CODEX_HOME` pointed at a selected environment.

Dependency solving, semantic version constraints, remote registries, and Claude
Code adapters are intentionally left for later releases.

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

## Reproducibility

`skillenv install` records installed skills in `lock.json`. `skillenv export`
uses that lock file when available, so another machine can recreate the
environment:

```bash
uv run skillenv export research > skillenv.yml
uv run skillenv create -f skillenv.yml
```

## Registry

The repository includes a seed registry in:

```text
registry/skills.json
```

The packaged CLI reads the bundled copy and exposes:

```bash
uv run skillenv registry list
uv run skillenv registry show pdf
```

The registry is intentionally small in the first release. It is metadata, not a
full dependency resolver.

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

## Open Source Project Files

- `LICENSE`: MIT license.
- `CONTRIBUTING.md`: development and PR guidelines.
- `.github/workflows/ci.yml`: test matrix for Python 3.11, 3.12, and 3.13.
- `.github/workflows/release.yml`: PyPI publishing on version tags.
- `RELEASE.md`: release checklist.
