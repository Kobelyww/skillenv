import os
from pathlib import Path


def default_home() -> Path:
    """Return the skillenv home directory."""
    configured = os.environ.get("SKILLENV_HOME")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".skillenv"


def envs_dir(home: Path | None = None) -> Path:
    """Return the directory containing named environments."""
    return (home or default_home()) / "envs"
