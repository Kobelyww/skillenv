# Skillenv MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python + Typer CLI that manages isolated Codex skill environments through separate `CODEX_HOME` directories.

**Architecture:** The CLI is thin and delegates behavior to focused modules: environment layout, manifest persistence, skill installation, command execution, and import/export. The first release supports Codex only by launching commands with `CODEX_HOME=<env-root>`.

**Tech Stack:** Python 3.11+, Typer, pytest, tomli-w, stdlib `venv`-free file operations.

---

## File Structure

- `pyproject.toml`: package metadata, console script, dependencies.
- `README.md`: user-facing quick start.
- `src/skillenv/__init__.py`: version export.
- `src/skillenv/cli.py`: Typer command definitions and output formatting.
- `src/skillenv/config.py`: path resolution for the skillenv home.
- `src/skillenv/envs.py`: environment create/list/remove/status logic.
- `src/skillenv/manifest.py`: `skillenv.yml` read/write helpers using JSON-compatible YAML subset.
- `src/skillenv/install.py`: local and GitHub skill installation.
- `src/skillenv/runner.py`: run commands with isolated `CODEX_HOME`.
- `tests/test_cli.py`: CLI behavior tests.
- `tests/test_envs.py`: filesystem behavior tests.

## Task 1: Project Skeleton

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `src/skillenv/__init__.py`
- Create: `src/skillenv/cli.py`
- Create: `tests/test_cli.py`

- [ ] **Step 1: Write failing CLI smoke test**

```python
from typer.testing import CliRunner

from skillenv.cli import app


def test_version_command_prints_version():
    result = CliRunner().invoke(app, ["version"])
    assert result.exit_code == 0
    assert "skillenv" in result.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cli.py::test_version_command_prints_version -q`

Expected: FAIL because package files are not implemented yet.

- [ ] **Step 3: Create minimal package and version command**

`src/skillenv/__init__.py`:

```python
__version__ = "0.1.0"
```

`src/skillenv/cli.py`:

```python
import typer

from skillenv import __version__

app = typer.Typer(help="Manage isolated agent skill environments.")


@app.command()
def version() -> None:
    """Print the skillenv version."""
    typer.echo(f"skillenv {__version__}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_cli.py::test_version_command_prints_version -q`

Expected: PASS.

## Task 2: Environment Creation And Listing

**Files:**
- Create: `src/skillenv/config.py`
- Create: `src/skillenv/envs.py`
- Modify: `src/skillenv/cli.py`
- Create: `tests/test_envs.py`
- Modify: `tests/test_cli.py`

- [ ] **Step 1: Write failing environment tests**

```python
from pathlib import Path

from skillenv.envs import create_env, list_envs


def test_create_env_creates_codex_home_layout(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    assert env.name == "research"
    assert env.root == tmp_path / "envs" / "research"
    assert (env.root / "skills").is_dir()
    assert (env.root / "plugins").is_dir()
    assert (env.root / "config.toml").is_file()
    assert (env.root / "skillenv.yml").is_file()


def test_list_envs_returns_existing_envs(tmp_path: Path):
    create_env("research", home=tmp_path)
    create_env("coding", home=tmp_path)

    assert [env.name for env in list_envs(home=tmp_path)] == ["coding", "research"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_envs.py -q`

Expected: FAIL because `skillenv.envs` does not exist.

- [ ] **Step 3: Implement environment layout**

Create an `Env` dataclass with `name` and `root`. `create_env` creates `skills/`, `plugins/`, `sessions/`, `log/`, `config.toml`, and `skillenv.yml`. `list_envs` returns sorted envs under `<home>/envs`.

- [ ] **Step 4: Add CLI commands**

Add:

```bash
skillenv create research
skillenv env list
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest tests/test_envs.py tests/test_cli.py -q`

Expected: PASS.

## Task 3: Install Local Skills

**Files:**
- Create: `src/skillenv/install.py`
- Modify: `src/skillenv/cli.py`
- Modify: `tests/test_envs.py`

- [ ] **Step 1: Write failing local install test**

```python
from pathlib import Path

from skillenv.envs import create_env
from skillenv.install import install_local_skill


def test_install_local_skill_copies_skill_directory(tmp_path: Path):
    source = tmp_path / "source-skill"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n")
    env = create_env("research", home=tmp_path)

    installed = install_local_skill(env, source)

    assert installed == env.root / "skills" / "source-skill"
    assert (installed / "SKILL.md").read_text() == "---\nname: demo\n---\n# Demo\n"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_envs.py::test_install_local_skill_copies_skill_directory -q`

Expected: FAIL because installer does not exist.

- [ ] **Step 3: Implement local install**

Copy a local directory containing `SKILL.md` into `<env>/skills/<source-name>`. Refuse overwrite unless `force=True`.

- [ ] **Step 4: Add CLI command**

Add:

```bash
skillenv install research /path/to/skill
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest -q`

Expected: PASS.

## Task 4: Export And Import

**Files:**
- Create: `src/skillenv/manifest.py`
- Modify: `src/skillenv/envs.py`
- Modify: `src/skillenv/cli.py`
- Modify: `tests/test_cli.py`

- [ ] **Step 1: Write failing export/import tests**

```python
from typer.testing import CliRunner

from skillenv.cli import app


def test_export_prints_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    result = runner.invoke(app, ["export", "research"])

    assert result.exit_code == 0
    assert "name: research" in result.stdout
    assert "adapter: codex" in result.stdout
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_cli.py::test_export_prints_manifest -q`

Expected: FAIL because export is not implemented.

- [ ] **Step 3: Implement manifest helpers**

Store a simple `skillenv.yml` with:

```yaml
name: research
adapter: codex
skills: []
plugins: []
```

- [ ] **Step 4: Add CLI commands**

Add:

```bash
skillenv export research
skillenv create -f skillenv.yml
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest -q`

Expected: PASS.

## Task 5: Run With Isolated CODEX_HOME

**Files:**
- Create: `src/skillenv/runner.py`
- Modify: `src/skillenv/cli.py`
- Create: `tests/test_runner.py`

- [ ] **Step 1: Write failing runner test**

```python
from pathlib import Path

from skillenv.envs import create_env
from skillenv.runner import build_run_env


def test_build_run_env_sets_codex_home(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    run_env = build_run_env(env, base={"PATH": "/bin"})

    assert run_env["CODEX_HOME"] == str(env.root)
    assert run_env["PATH"] == "/bin"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_runner.py -q`

Expected: FAIL because runner does not exist.

- [ ] **Step 3: Implement run helper**

`build_run_env` copies the base environment and sets `CODEX_HOME`. `run_command` invokes `subprocess.run` with that environment.

- [ ] **Step 4: Add CLI command**

Add:

```bash
skillenv run research -- codex
```

- [ ] **Step 5: Run tests**

Run: `uv run pytest -q`

Expected: PASS.

## Task 6: Documentation And Validation

**Files:**
- Modify: `README.md`
- Modify: `pyproject.toml`

- [ ] **Step 1: Document quick start**

Add examples for `create`, `install`, `run`, `export`, and `remove`.

- [ ] **Step 2: Validate package metadata**

Run: `uv run python -m skillenv.cli version`

Expected: prints `skillenv 0.1.0`.

- [ ] **Step 3: Run full tests**

Run: `uv run pytest -q`

Expected: PASS.
