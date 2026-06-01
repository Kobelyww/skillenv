import json
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


def add_skill_record(env: Env, name: str, source: str) -> None:
    data = read_lock(env)
    skills = [skill for skill in data["skills"] if skill["name"] != name]
    skills.append({"name": name, "source": source})
    data["skills"] = sorted(skills, key=lambda skill: skill["name"])
    write_lock(env, data)
