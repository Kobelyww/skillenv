# Manifest Spec

`skillenv.yml` describes how to recreate an environment. It lives at the
environment root and is standard YAML.

## Format

```yaml
name: research            # environment name (required)
adapter: codex            # codex | claude | pi | gemini | generic (default: codex)
skills:                   # install specs (strings)
  - pdf@^1.0              # registry name + semver range
  - latex                 # registry name, any version
  - github:openai/skills/skills/.curated/pdf@main   # GitHub subtree
  - ./skills/custom-search  # local path
plugins:                  # plugin selectors (adapter-specific)
  - latex@openai-bundled
```

## Rules

- `name` is required and must be a valid environment name (no path
  separators, not `.` or `..`).
- `skills` and `plugins` default to `[]`.
- Name specs (`pdf@^1.0`) resolve through the registry with full dependency
  closure; source specs (`github:...`, `local:...`, paths) install directly.
- The legacy 1.x inline-list format (`skills: [pdf, latex]`) is valid YAML
  flow syntax and parses identically.

## Creating from a manifest

```bash
skillenv create -f skillenv.yml
```

The environment is created under `SKILLENV_HOME` (default `~/.skillenv`),
skills install with force semantics (fresh environment), and plugin selectors
are recorded.

## Exporting

`skillenv export <env>` prints a manifest. When the lock records installs,
the export lists lock sources (exact `github:` refs and local paths), which is
what makes environments reproducible. With an empty lock it echoes the
manifest as-is.

## Clone semantics

`skillenv clone src target` copies `skills/`, `plugins/`, `config.toml`, and
`lock.json`, and rewrites the `name:` line of the manifest. Sessions and logs
are not copied.
