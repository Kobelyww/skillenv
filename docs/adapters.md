# Adapters

Adapters are thin integration layers around the standalone `skillenv` CLI. Core
environment behavior stays in the Python package.

## Codex

Generate a Codex plugin scaffold:

```bash
uv run skillenv adapter codex --out plugins
```

Output:

```text
plugins/skillenv-codex/
  .codex-plugin/plugin.json
  skills/skillenv/SKILL.md
```

## Claude Code

Generate a Claude Code skill scaffold:

```bash
uv run skillenv adapter claude-code --out adapters
```

Output:

```text
adapters/skillenv-claude-code/
  .claude/skills/skillenv/SKILL.md
```

Use this when you want Claude Code to understand the local `skillenv` commands
and workflows. The generated adapter does not install `skillenv`; install the
CLI separately with your preferred Python tool.
