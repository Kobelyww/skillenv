# Publishing

The project is configured for PyPI releases through GitHub Actions.

## Release Flow

1. Update the version in `pyproject.toml`.
2. Update `README.md` and docs for user-facing changes.
3. Run tests:

   ```bash
   PYTHONPATH=src uv run pytest -q
   ```

4. Build distributions:

   ```bash
   uv build
   ```

5. Tag the release:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The release workflow publishes with trusted publishing when PyPI is configured
for this repository.

## Future Channels

Homebrew and shell installer support should wait until the package name,
versioning policy, and CLI surface are stable.
