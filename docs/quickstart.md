# Quickstart

Five minutes from zero to an isolated agent environment.

## Install

```bash
npm install -g @kobelyww/skillenv
skillenv version
```

Requires Node 20+.

## Create your first environment

```bash
skillenv create research
# created research: ~/.skillenv/envs/research
```

Or start from a preset:

```bash
skillenv preset list
skillenv create research --preset research
```

The directory layout:

```text
~/.skillenv/envs/research/
  config.toml   skillenv.yml   lock.json
  skills/       plugins/       sessions/       log/
```

Everything an agent CLI needs lives inside this one directory.

## Install skills

Three source kinds — mix them freely:

```bash
# registry name (versioned, resolves dependencies)
skillenv install research pdf@^1.0

# GitHub subtree (any repo, any path, any ref)
skillenv install research github:openai/skills/skills/.curated/pdf

# local directory (must contain SKILL.md)
skillenv install research ./my-skills/custom-search
```

Every install is recorded in `lock.json` with its source and a sha256
checksum. `skillenv doctor research` re-verifies the checksums any time.

## Run an agent inside it

```bash
# Codex: CODEX_HOME points at the environment
skillenv run research -- codex

# Claude Code: CLAUDE_CONFIG_DIR points at the environment
skillenv create claude-research --adapter claude
skillenv run claude-research -- claude

# or use the built-in agent — no external CLI needed
export DEEPSEEK_API_KEY=sk-...
skillenv agent research --dir ~/my-project
```

## Reproduce it somewhere else

```bash
skillenv export research > skillenv.yml
# on another machine
skillenv create -f skillenv.yml
```

## Day-2 commands

```bash
skillenv env list              # all environments
skillenv env info research     # what's inside one
skillenv diff research work    # what differs between two
skillenv clone research research-v2
skillenv remove research-v2
```

Next: [the built-in agent](agent.md) · [adapters](adapters.md) ·
[manifest spec](manifest-spec.md)
