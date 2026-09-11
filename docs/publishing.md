# Publishing

How to release the CLI and how to publish skills into a registry.

## Releasing the CLI

1. Update `src/version.ts` and `package.json` (keep them in sync).
2. Update `CHANGELOG.md`.
3. Run the gates: `npm run typecheck && npm test && npm run build`.
4. Tag and push: `git tag v2.x.y && git push origin v2.x.y`.
5. GitHub Actions (`.github/workflows/release.yml`) publishes the package to
   npm on version tags — requires the `NPM_TOKEN` secret.

## Publishing a skill to a registry

`skillenv registry publish` validates a skill directory and emits or upserts
a versioned registry entry.

Requirements checked:

- The directory contains `SKILL.md`.
- Frontmatter has `name`, `description`, and `version`.
- `version` is valid semver (`X.Y.Z`, optional `-prerelease`).

```bash
# validate + print the entry (stdout)
skillenv registry publish ./skills/latex-paper

# record the published location users will install from
skillenv registry publish ./skills/latex-paper \
  --source github:me/skills/skills/latex-paper@v1.2.0

# declare dependencies for the published version
skillenv registry publish ./skills/latex-paper \
  --source github:me/skills/skills/latex-paper@v1.2.0 \
  --depends "pdf@^1.0,zotero@>=2"

# upsert directly into a registry file (sorted by name, replaces by name)
skillenv registry publish ./skills/latex-paper -r ./team-registry.json
```

Output entry format:

```json
{
  "version": 2,
  "skills": [
    {
      "name": "latex-paper",
      "description": "Write LaTeX papers with citations.",
      "versions": {
        "1.2.0": {
          "source": "github:me/skills/skills/latex-paper@v1.2.0",
          "dependencies": ["pdf@^1.0"]
        }
      }
    }
  ]
}
```

## Distributing a registry

A registry is just a JSON file. Serve it over HTTPS, commit it to a repo, or
share it on a mount — then consumers add it:

```bash
skillenv registry add team https://example.com/team-registry.json
skillenv registry add local-team ./team-registry.json   # file paths work too
skillenv registry update      # refresh the cache (~/.skillenv/registry-cache)
skillenv registry list        # bundled + cached entries, later sources win
```

## First-party skills in this repo

`skills/skillenv-basics` is the reference first-party skill; it is listed in
the bundled registry and teaches any host agent how to drive skillenv.
