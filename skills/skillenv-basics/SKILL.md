---
name: skillenv-basics
description: Use when an agent needs to create, inspect, or modify skillenv environments — isolated homes of skills for Codex, Claude Code, pi, or generic agent CLIs. Covers create/clone/install/export/doctor and running agents inside an environment.
version: 1.0.0
---

# skillenv basics

`skillenv` manages isolated agent environments. Each environment is a directory
under `~/.skillenv/envs/<name>` containing `skills/`, `plugins/`, `sessions/`,
`log/`, a `skillenv.yml` manifest, and a `lock.json` recording what was installed.

## Core commands

```bash
skillenv create <name> [--adapter codex|claude|pi|gemini|generic] [--preset clean|coding|research]
skillenv clone <source> <target>
skillenv install <env> <spec>            # spec: name[@range] | github:owner/repo/path[@ref] | local path
skillenv remove <env>
skillenv export <env>                    # print a reproducible manifest
skillenv create -f skillenv.yml          # recreate from a manifest
skillenv env list | skillenv env info <env>
skillenv doctor <env>                    # verify layout, SKILL.md presence, checksums
skillenv diff <a> <b>
skillenv run <env> [-- <command args>]   # run with the adapter's isolation env vars set
skillenv agent <env> --provider deepseek --model deepseek-chat   # built-in coding agent
```

## Rules

- Installing into an environment mutates `lock.json`; never edit it by hand.
- `github:` sources download a repository zipball and copy the skill subtree;
  the subtree must contain a `SKILL.md`.
- Registry names resolve with version ranges (`pdf@^1.0`) and pull in declared
  dependencies automatically.
- `skillenv run` sets `CODEX_HOME` (codex), `CLAUDE_CONFIG_DIR` (claude), or
  `PI_CONFIG_DIR` (pi) plus generic `SKILLENV_*` variables.
