# Security Policy

## Scope

`skillenv` is a local developer tool. The security-relevant surfaces are:

1. **The built-in agent (`skillenv agent`)** — it executes shell commands
   (`run_command`), writes files, and fetches URLs on behalf of the model.
2. **Skill installation** — skills come from local directories, GitHub
   zipballs, or registry sources.

## Agent tool posture

The agent is a *coding agent*: by design it can execute real commands and
edit real files in the working directory you give it. There is no sandbox at
the tool level. Operate it the way you would operate any coding agent CLI:

- Run it inside a project checkout; never from a directory containing secrets
  you would not expose to your model provider.
- Use `--tools` to drop dangerous tools for untrusted tasks:
  `skillenv agent <env> --tools read_file,list_dir,grep,skill_list,skill_read`.
- `run_command` is timeout-guarded (default 60s, max 300s).
- `web_fetch` blocks non-http(s) schemes, resolves DNS and rejects
  loopback/private/link-local targets (SSRF guard), and caps the response at
  32 KB.
- Prompts and tool outputs are sent to the configured model provider — apply
  your provider's data policy to whatever the agent can read.

## Skill installation

- GitHub sources download a repository zipball over HTTPS and copy the
  requested subtree; the subtree must contain a `SKILL.md`. Repo paths and
  refs containing `.`/`..` traversal segments are rejected before any
  download.
- Skills are markdown + assets; they are not executed at install time.
  `lock.json` records a sha256 checksum of every installed tree, and
  `skillenv doctor <env>` detects tampering.
- Registry entries are validated JSON; a corrupt cache entry is ignored
  rather than executed.

## Reporting

Open a GitHub issue at <https://github.com/Kobelyww/skillenv/issues> for
anything you find. For sensitive reports, describe the impact and a
reproduction and mark the issue title with `[security]`.
