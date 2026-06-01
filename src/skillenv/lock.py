import json
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from skillenv.envs import Env


def default_lock() -> dict:
    return {
        "version": 1,
        "skills": [],
        "plugins": [],
    }


def lock_path(env: Env) -> Path:
    return env.root / "lock.json"


def read_lock(env: Env) -> dict:
    path = lock_path(env)
    if not path.exists():
        return default_lock()
    return json.loads(path.read_text(encoding="utf-8"))


def write_lock(env: Env, data: dict) -> None:
    lock_path(env).write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def directory_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    for file_path in sorted(item for item in path.rglob("*") if item.is_file()):
        relative_path = file_path.relative_to(path).as_posix()
        digest.update(relative_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(file_path.read_bytes())
        digest.update(b"\0")
    return f"sha256:{digest.hexdigest()}"


def add_skill_record(env: Env, name: str, source: str) -> None:
    data = read_lock(env)
    skills = [skill for skill in data["skills"] if skill["name"] != name]
    skill_path = env.root / "skills" / name
    record = {
        "name": name,
        "source": source,
        "installed_at": utc_now(),
    }
    if skill_path.is_dir():
        record["checksum"] = directory_checksum(skill_path)
    skills.append(record)
    data["skills"] = sorted(skills, key=lambda skill: skill["name"])
    write_lock(env, data)


def add_plugin_record(env: Env, name: str, source: str) -> None:
    data = read_lock(env)
    plugins = [plugin for plugin in data["plugins"] if plugin["name"] != name]
    plugins.append({"name": name, "source": source, "installed_at": utc_now()})
    data["plugins"] = sorted(plugins, key=lambda plugin: plugin["name"])
    write_lock(env, data)
