from skillenv.presets import get_preset, list_presets


def test_list_presets_contains_default_profiles():
    assert list_presets() == ["clean", "coding", "research"]


def test_get_research_preset_returns_expected_skills():
    preset = get_preset("research")

    assert preset.name == "research"
    assert preset.skills == ["pdf", "jupyter-notebook", "latex", "zotero", "transcribe"]
