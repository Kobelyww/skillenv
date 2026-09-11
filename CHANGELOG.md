# Changelog

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
