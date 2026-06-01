# Quickstart

`skillenv` manages isolated agent skill environments. The first supported
runtime is Codex, where each environment is a separate `CODEX_HOME`.

Create a clean environment:

```bash
uv run skillenv create research
```

Create from a preset:

```bash
uv run skillenv create research-lab --preset research --install-plugins
```

Install a skill:

```bash
uv run skillenv install research pdf
```

Run Codex with the environment active:

```bash
uv run skillenv run research -- codex
```

Export a reproducible manifest:

```bash
uv run skillenv export research > skillenv.yml
```

Recreate an environment from that manifest:

```bash
uv run skillenv create -f skillenv.yml
```
