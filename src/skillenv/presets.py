from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    name: str
    description: str
    skills: list[str]
    plugins: list[str]


PRESETS = {
    "clean": Preset(
        name="clean",
        description="Minimal isolated Codex home with no extra skills.",
        skills=[],
        plugins=[],
    ),
    "coding": Preset(
        name="coding",
        description="Software engineering environment.",
        skills=["openai-docs", "superpowers", "token-usage-meter"],
        plugins=["browser@openai-bundled", "superpowers@openai-curated"],
    ),
    "research": Preset(
        name="research",
        description="Research and paper-writing environment.",
        skills=["pdf", "jupyter-notebook", "latex", "zotero", "transcribe"],
        plugins=["latex@openai-bundled", "zotero@openai-curated"],
    ),
}


def list_presets() -> list[str]:
    return sorted(PRESETS)


def get_preset(name: str) -> Preset:
    try:
        return PRESETS[name]
    except KeyError as exc:
        raise ValueError(f"unknown preset: {name}") from exc
