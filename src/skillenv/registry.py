import json
from dataclasses import dataclass
from importlib.resources import files
from pathlib import Path
import urllib.request

from skillenv.config import default_home


@dataclass(frozen=True)
class RegistrySkill:
    name: str
    source: str
    description: str


def load_registry() -> dict:
    registry_path = files("skillenv").joinpath("registry/skills.json")
    return json.loads(registry_path.read_text(encoding="utf-8"))


def registries_path(home: Path | None = None) -> Path:
    return (home or default_home()) / "registries.json"


def registry_cache_dir(home: Path | None = None) -> Path:
    return (home or default_home()) / "registry-cache"


def list_registry_sources(home: Path | None = None) -> list[dict[str, str]]:
    path = registries_path(home)
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("registries", [])


def add_registry_source(name: str, url: str, home: Path | None = None) -> None:
    path = registries_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    sources = [source for source in list_registry_sources(home) if source["name"] != name]
    sources.append({"name": name, "url": url})
    sources.sort(key=lambda source: source["name"])
    path.write_text(json.dumps({"version": 1, "registries": sources}, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_registry_url(url: str) -> dict:
    path = Path(url).expanduser()
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    with urllib.request.urlopen(url) as response:
        return json.loads(response.read().decode("utf-8"))


def update_registry_cache(home: Path | None = None) -> None:
    cache_dir = registry_cache_dir(home)
    cache_dir.mkdir(parents=True, exist_ok=True)
    for source in list_registry_sources(home):
        data = read_registry_url(source["url"])
        (cache_dir / f"{source['name']}.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def iter_registry_payloads(home: Path | None = None) -> list[dict]:
    payloads = [load_registry()]
    cache_dir = registry_cache_dir(home)
    if cache_dir.exists():
        for path in sorted(cache_dir.glob("*.json")):
            payloads.append(json.loads(path.read_text(encoding="utf-8")))
    return payloads


def list_registry_skills(home: Path | None = None) -> list[RegistrySkill]:
    items = {}
    for data in iter_registry_payloads(home):
        for item in data["skills"]:
            items[item["name"]] = item
    return [
        RegistrySkill(
            name=item["name"],
            source=item["source"],
            description=item.get("description", ""),
        )
        for item in sorted(items.values(), key=lambda entry: entry["name"])
    ]


def search_registry_skills(query: str, home: Path | None = None) -> list[RegistrySkill]:
    needle = query.lower()
    return [
        skill
        for skill in list_registry_skills(home)
        if needle in skill.name.lower() or needle in skill.description.lower() or needle in skill.source.lower()
    ]


def get_registry_skill(name: str, home: Path | None = None) -> RegistrySkill:
    for skill in list_registry_skills(home):
        if skill.name == name:
            return skill
    raise KeyError(f"registry skill not found: {name}")
