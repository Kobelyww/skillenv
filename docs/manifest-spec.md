# Manifest Spec

`skillenv.yml` describes how to recreate an environment.

Current format:

```yaml
name: research
adapter: codex
skills: [pdf, jupyter-notebook]
plugins: [latex@openai-bundled]
```

## Fields

`name` is the environment name under `~/.skillenv/envs/`.

`adapter` identifies the primary agent runtime. The current default is `codex`.

`skills` is an inline list of skill sources. Supported source forms:

- Registry name, such as `pdf`.
- Local path, such as `local:/path/to/skill`.
- GitHub source, such as `github:openai/skills/skills/.curated/pdf`.

`plugins` is an inline list of plugin selectors. Plugin selectors are recorded
in `config.toml` and `lock.json`; plugin cache download is outside the current
scope.

## Import

Create an environment from a manifest:

```bash
uv run skillenv create -f skillenv.yml
```
