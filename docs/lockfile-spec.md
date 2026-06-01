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
      "source": "github:openai/skills/skills/.curated/pdf"
    }
  ],
  "plugins": [
    {
      "name": "latex@openai-bundled",
      "source": "latex@openai-bundled"
    }
  ]
}
```

## Semantics

`version` is the lockfile schema version.

`skills` records installed skills by environment-local name and original source.

`plugins` records enabled plugin selectors by name and source.

Future versions should add resolved references, checksums, and install
timestamps so environments can be reproduced more strictly.
