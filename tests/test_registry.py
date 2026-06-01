from skillenv.registry import get_registry_skill, list_registry_skills


def test_list_registry_skills_contains_seed_entries():
    names = [skill.name for skill in list_registry_skills()]

    assert "pdf" in names
    assert "jupyter-notebook" in names


def test_get_registry_skill_returns_github_source():
    skill = get_registry_skill("pdf")

    assert skill.name == "pdf"
    assert skill.source == "github:openai/skills/skills/.curated/pdf"
