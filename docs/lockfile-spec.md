# Lockfile Spec

`lock.json` records exactly what was installed into an environment. It is
machine-written — never edit it by hand; reinstall or `doctor` instead.

## Location

```text
~/.skillenv/envs/<name>/lock.json
```

## Format (version 2)

```json
{
  "version": 2,
  "skills": [
    {
      "name": "pdf",
      "source": "github:openai/skills/skills/.curated/pdf@main",
      "installed_at": "2026-09-12T03:20:44Z",
      "version": "1.0.0",
      "dependencies": ["pdf-core@^1"],
      "checksum": "sha256:9f2c…"
    }
  ],
  "plugins": [
    {
      "name": "latex@openai-bundled",
      "source": "latex@openai-bundled",
      "installed_at": "2026-09-12T03:20:44Z"
    }
  ]
}
```

### Skill records

| Field | Meaning |
|---|---|
| `name` | Skill directory name under `skills/` |
| `source` | Where it came from: `local:<abs-path>`, `github:<owner>/<repo>/<path>@<ref>`, or another registry source |
| `installed_at` | UTC timestamp of the install |
| `version` | Resolved semantic version (registry installs) or frontmatter version (direct installs) |
| `dependencies` | Dependency specs this install pulled in, verbatim |
| `checksum` | `sha256:` digest of the installed tree; omitted when the directory was absent at record time |

### Checksum algorithm

The checksum is stable across machines and platforms:

1. Walk the skill directory; collect every file's path relative to the skill
   root with `/` separators, sorted lexicographically.
2. For each file in order, feed into sha256: the relative path, a NUL byte,
   the file bytes, a NUL byte.
3. Prefix the hex digest with `sha256:`.

`skillenv doctor <env>` recomputes checksums and reports
`checksum mismatch: skills/<name>` when installed content drifts from the
lock.

### Version compatibility

Version 1 locks (Python 1.x era: flat `{name, source, installed_at[, checksum]}`
records, no `version`/`dependencies` fields) are read transparently and
upgraded in place on the next write. Unknown fields are preserved per record
when round-tripping through the CLI's own reads and writes.
