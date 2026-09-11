# Contributing

Thanks for helping improve `skillenv`.

## Development

```bash
npm install
npm run build       # tsup → dist/
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run skillenv -- env list   # run the CLI from source
```

## Architecture map

```text
src/
  config.ts       SKILLENV_HOME resolution and well-known paths
  env.ts          environment lifecycle: create/clone/list/remove
  manifest.ts     skillenv.yml (YAML) parse/render/export
  lock.ts         lock.json, sha256 directory checksums, install records
  skill.ts        SKILL.md frontmatter (name/description/version/dependencies)
  resolve.ts      semver dependency resolution (the interesting part)
  installer.ts    spec partition + registry-driven install orchestration
  install.ts      local + GitHub zipball source installers
  registry.ts     bundled + user registries, caching, search
  publish.ts      registry publish validation and upsert
  adapter.ts      adapter registry: home vars, default commands, doctor rules
  plugins.ts      config.toml [plugins."selector"] blocks
  inspect.ts      doctor + diff
  runner.ts       buildRunEnv + spawn with adapter isolation
  cli.ts          commander wiring for env-management commands
  agent/
    providers.ts  OpenAI-compatible presets + SSE streaming client
    tools.ts      the agent toolbox (fs/shell/web/skills)
    loop.ts       system prompt + tool-calling turn loop
    session.ts    per-environment session transcripts
    render.ts     terminal rendering (terminal vs quiet)
    cli.ts        `skillenv agent` + `skillenv session` commands
tests/            vitest: unit + CLI e2e + mock-provider agent e2e
```

## Conventions

- Strict TypeScript (`noUncheckedIndexedAccess` on); no `any`.
- New behavior needs tests; run `npx vitest run` before pushing.
- Preserve Python-1.x semantics where noted in tests (error strings, lock
  format) — they are part of the compatibility contract.

## Project direction

`skillenv` is a Conda-like environment manager for agent skills. Keep changes
focused on reproducible environments, registry metadata, adapters, reliable
installation workflows, and the built-in agent.

## Pull requests

- One logical change per PR; include tests and doc updates.
- `docs/` stays in sync with CLI behavior.
- CI must be green: typecheck, build, tests, CLI smoke.
