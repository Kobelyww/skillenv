# Lockfile Spec

`lock.json` records what was installed into an environment. It is written under
the environment root:

```text
~/.skillenv/envs/<name>/lock.json
```

Current format:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "pdf",
      "source": "github:openai/skills/skills/.curated/pdf",
      "installed_at": "2026-06-01T12:34:56Z",
      "checksum": "sha256:..."
    }
  ],
  "plugins": [
    {
      "name": "latex@openai-bundled",
      "source": "latex@openai-bundled",
      "installed_at": "2026-06-01T12:34:56Z"
    }
  ]
}
```

## Semantics

`version` is the lockfile schema version.

`skills` records installed skills by environment-local name and original source.
New skill records include `installed_at` and a deterministic directory
`checksum`.

`plugins` records enabled plugin selectors by name and source. New plugin
records include `installed_at`.

`installed_at` uses UTC ISO-8601 format with a trailing `Z`.

`checksum` is a `sha256:` digest over each file path and file content in the
installed skill directory. `skillenv doctor` uses it to detect local skill
content drift. Older lock records without checksums remain valid but cannot be
checked for content drift.

Future versions should add resolved references so GitHub and remote registry
sources can be reproduced more strictly.
