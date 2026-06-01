# Contributing

Thanks for helping improve `skillenv`.

## Development

```bash
uv sync --dev
PYTHONPATH=src uv run pytest -q
PYTHONPATH=src uv run python -m skillenv --help
```

## Project Direction

`skillenv` is a Conda-like environment manager for agent skills. Keep changes
focused on reproducible environments, registry metadata, adapters, and reliable
installation workflows.

## Pull Requests

- Add tests for behavior changes.
- Keep CLI output stable and script-friendly.
- Avoid network-dependent tests; inject downloaders or use fixtures.
- Update `README.md` when commands or workflows change.

