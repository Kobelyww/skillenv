# Development Log — the v2 rewrite

How skillenv went from a 1,000-line Python prototype to the current
TypeScript CLI + built-in coding agent. Written as a record of decisions and
verification, not a diary.

## Timeline

| Milestone | What landed |
|---|---|
| **v2 rewrite (M1)** | TypeScript 5 strict port of the full env lifecycle: YAML manifests (legacy format compatible), sha256-verified lock files, presets, plugins, doctor/diff/export |
| **Dependency resolution (M2)** | Semver constraint intersection across requirers, conflict errors with full chains, topological install order, cycle tolerance |
| **Adapters (M3)** | First-class adapter registry: `codex`/`claude`/`pi`/`gemini`/`generic` with isolation vars, default commands, doctor rules, artifact scaffolds |
| **Registry v2 + publish (M4)** | Versioned entries, file/HTTP sources with caching, validated `registry publish` |
| **Built-in agent (M5)** | Streaming tool-calling loop, 10→12 workspace tools, sessions, skill injection, provider failover |
| **Docs & release (M6)** | README + 6 guides, CI matrix, npm release workflow, SECURITY.md |
| **Hardening rounds** | Retry with backoff, context-overflow compaction retry, parallel tool execution, persistent memory, agent-eval framework, per-case providers, Anthropic protocol, Windows fixes |

## Key decisions

- **TypeScript over Rust**: no local Rust toolchain; Node's ecosystem fits the
  workload (SSE streaming, YAML, markdown, spawn management), and `npm i -g`
  is the lowest-friction distribution for a CLI aimed at agent users.
- **Real YAML manifests** instead of the 1.x line parser — the old inline
  format is valid YAML flow syntax, so both eras parse identically.
- **Fixpoint dependency resolution**: new constraints invalidate previous
  picks and re-enqueue the skill; cycles fall out of the worklist naturally.
- **Deterministic memory recall**: non-empty memory is injected into every
  system prompt. The first live test showed the model skipped an on-demand
  `memory_read` (it read "without reading files" too literally) — so recall
  is never left to the model's initiative.
- **Failover never duplicates output**: if any token reached the terminal, a
  provider failure propagates instead of retrying.
- **Per-source registry fault tolerance**: one broken source warns; the rest
  still update. Only a total failure exits non-zero.

## Self-hosting

Three features were implemented by skillenv's own agent (`deepseek-chat`)
working on copies of this repository, then reviewed, tested, and adopted:

- `env rename` (M6-era iteration)
- the eval `agent-contains` expectation
- cumulative session token usage
- two SSE/reliability bugs in the streaming client (a final event without a
  trailing newline was dropped; a mid-stream failure after partial output
  triggered a duplicating retry) — round #6 reviewed loop.ts/providers.ts and
  reported both candidates honestly as unverified; they were confirmed with
  regression tests during review

Each round surfaced the same workflow value: the agent writes code + tests
and reports its own verification state; the human reviews the diff and runs
the full gates before adopting.

## Verification evidence

- **Tests**: 157 passing (+1 platform-skipped) across 16 files — unit, CLI
  e2e (spawned binary), and agent e2e against mock providers for both the
  OpenAI and Anthropic protocols.
- **CI**: Node 20/22 × ubuntu/macos/windows — lint, typecheck, build, tests,
  CLI smoke. All green on `main`.
- **Live runs** (real DeepSeek API): multi-session coding tasks with
  self-repair; provider failover from a dead endpoint; skill consumption via
  `skill_list`/`skill_read` against a real installed skill; `agent-eval`
  2/2 with tool-sequence and file assertions; cross-session memory recall.
- **Live integrations**: Codex CLI 0.153.4 (`CODEX_HOME`) and Claude Code
  2.1.139 (`CLAUDE_CONFIG_DIR`) launched through `skillenv run`; real GitHub
  skill installs from this repo and `openai/skills`.
