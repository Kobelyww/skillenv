from pathlib import Path

from skillenv.envs import Env
from skillenv.lock import read_lock


DEFAULT_MANIFEST = {
    "adapter": "codex",
    "skills": [],
    "plugins": [],
}


def render_manifest(name: str, adapter: str = "codex", skills: list[str] | None = None, plugins: list[str] | None = None) -> str:
    skills = skills or []
    plugins = plugins or []
    return (
        f"name: {name}\n"
        f"adapter: {adapter}\n"
        f"skills: {format_inline_list(skills)}\n"
        f"plugins: {format_inline_list(plugins)}\n"
    )


def format_inline_list(items: list[str]) -> str:
    if not items:
        return "[]"
    return "[" + ", ".join(items) + "]"


def write_default_manifest(env: Env) -> Path:
    path = env.root / "skillenv.yml"
    path.write_text(render_manifest(env.name), encoding="utf-8")
    return path


def read_manifest(env: Env) -> str:
    path = env.root / "skillenv.yml"
    return path.read_text(encoding="utf-8")


def export_manifest(env: Env) -> str:
    data = read_lock(env)
    skills = [skill["source"] for skill in data["skills"]]
    plugins = [plugin["source"] if isinstance(plugin, dict) and "source" in plugin else str(plugin) for plugin in data["plugins"]]
    if not skills and not plugins:
        return read_manifest(env)
    return render_manifest(env.name, skills=skills, plugins=plugins)


def parse_manifest_name(text: str) -> str:
    for line in text.splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
            if not name:
                raise ValueError("manifest name cannot be empty")
            return name
    raise ValueError("manifest is missing name")


def parse_inline_list(text: str, key: str) -> list[str]:
    prefix = f"{key}:"
    for line in text.splitlines():
        if line.startswith(prefix):
            value = line.split(":", 1)[1].strip()
            if value == "[]":
                return []
            if not (value.startswith("[") and value.endswith("]")):
                raise ValueError(f"manifest {key} must use inline list syntax")
            body = value[1:-1].strip()
            if not body:
                return []
            return [item.strip() for item in body.split(",") if item.strip()]
    return []


def load_manifest_file(path: Path) -> tuple[str, str]:
    text = path.expanduser().read_text(encoding="utf-8")
    return parse_manifest_name(text), text
