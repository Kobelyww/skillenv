import json
from dataclasses import dataclass
from importlib.resources import files


@dataclass(frozen=True)
class RegistrySkill:
    name: str
    source: str
    description: str


def load_registry() -> dict:
    registry_path = files("skillenv").joinpath("registry/skills.json")
    return json.loads(registry_path.read_text(encoding="utf-8"))


def list_registry_skills() -> list[RegistrySkill]:
    data = load_registry()
    return [
        RegistrySkill(
            name=item["name"],
            source=item["source"],
            description=item.get("description", ""),
        )
        for item in sorted(data["skills"], key=lambda entry: entry["name"])
    ]


def get_registry_skill(name: str) -> RegistrySkill:
    for skill in list_registry_skills():
        if skill.name == name:
            return skill
    raise KeyError(f"registry skill not found: {name}")
