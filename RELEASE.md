# Release

`skillenv` publishes from Git tags.

1. Update the version in `pyproject.toml` and `src/skillenv/__init__.py`.
2. Run:

```bash
PYTHONPATH=src uv run pytest -q
uv build
```

3. Commit the release change.
4. Tag and push:

```bash
git tag v0.1.0
git push origin main --tags
```

The release workflow uses PyPI trusted publishing via GitHub Actions OIDC.

