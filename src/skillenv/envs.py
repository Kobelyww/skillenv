import shutil
from dataclasses import dataclass
from pathlib import Path

from skillenv.config import envs_dir


@dataclass(frozen=True)
class Env:
    name: str
    root: Path


def validate_env_name(name: str) -> str:
    if not name:
        raise ValueError("environment name cannot be empty")
    if "/" in name or "\\" in name:
        raise ValueError("environment name cannot contain path separators")
    if name in {".", ".."}:
        raise ValueError("environment name cannot be '.' or '..'")
    return name


def env_path(name: str, home: Path | None = None) -> Path:
    return envs_dir(home) / validate_env_name(name)


def create_env(name: str, home: Path | None = None) -> Env:
    root = env_path(name, home)
    root.mkdir(parents=True, exist_ok=True)
    for dirname in ("skills", "plugins", "sessions", "log"):
        (root / dirname).mkdir(exist_ok=True)

    config_file = root / "config.toml"
    if not config_file.exists():
        config_file.write_text("# skillenv managed Codex home\n", encoding="utf-8")

    manifest_file = root / "skillenv.yml"
    if not manifest_file.exists():
        manifest_file.write_text(f"name: {name}\nadapter: codex\nskills: []\nplugins: []\n", encoding="utf-8")

    return Env(name=name, root=root)


def clone_env(source_name: str, target_name: str, home: Path | None = None) -> Env:
    source = get_env(source_name, home)
    target_root = env_path(target_name, home)
    if target_root.exists():
        raise FileExistsError(f"environment already exists: {target_name}")

    target = create_env(target_name, home)
    for dirname in ("skills", "plugins"):
        shutil.rmtree(target.root / dirname)
        shutil.copytree(source.root / dirname, target.root / dirname)

    for filename in ("config.toml", "lock.json"):
        source_file = source.root / filename
        if source_file.exists():
            shutil.copy2(source_file, target.root / filename)

    source_manifest = source.root / "skillenv.yml"
    if source_manifest.exists():
        target_manifest = rewrite_manifest_name(source_manifest.read_text(encoding="utf-8"), target_name)
        (target.root / "skillenv.yml").write_text(target_manifest, encoding="utf-8")

    return target


def rewrite_manifest_name(text: str, target_name: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.startswith("name:"):
            lines[index] = f"name: {target_name}"
            return "\n".join(lines) + ("\n" if text.endswith("\n") else "")
    return f"name: {target_name}\n{text}"


def get_env(name: str, home: Path | None = None) -> Env:
    root = env_path(name, home)
    if not root.is_dir():
        raise FileNotFoundError(f"environment not found: {name}")
    return Env(name=name, root=root)


def list_envs(home: Path | None = None) -> list[Env]:
    base = envs_dir(home)
    if not base.exists():
        return []
    return [
        Env(name=path.name, root=path)
        for path in sorted(base.iterdir(), key=lambda item: item.name)
        if path.is_dir()
    ]


def remove_env(name: str, home: Path | None = None) -> None:
    root = env_path(name, home)
    if not root.is_dir():
        raise FileNotFoundError(f"environment not found: {name}")
    shutil.rmtree(root)
