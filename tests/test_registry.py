import json

from skillenv.registry import (
    add_registry_source,
    get_registry_skill,
    list_registry_skills,
    list_registry_sources,
    search_registry_skills,
    update_registry_cache,
)


def test_list_registry_skills_contains_seed_entries():
    names = [skill.name for skill in list_registry_skills()]

    assert "pdf" in names
    assert "jupyter-notebook" in names


def test_get_registry_skill_returns_github_source():
    skill = get_registry_skill("pdf")

    assert skill.name == "pdf"
    assert skill.source == "github:openai/skills/skills/.curated/pdf"


def test_add_registry_source_records_source(tmp_path):
    registry_file = tmp_path / "skills.json"
    registry_file.write_text('{"version": 1, "skills": []}', encoding="utf-8")

    add_registry_source("local", str(registry_file), home=tmp_path)

    assert list_registry_sources(home=tmp_path) == [
        {
            "name": "local",
            "url": str(registry_file),
        }
    ]


def test_update_registry_cache_reads_local_source(tmp_path):
    registry_file = tmp_path / "skills.json"
    registry_file.write_text(
        json.dumps(
            {
                "version": 1,
                "skills": [
                    {
                        "name": "demo",
                        "source": "github:example/demo/skills/demo",
                        "description": "Demo skill",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    add_registry_source("local", str(registry_file), home=tmp_path)

    update_registry_cache(home=tmp_path)

    skills = list_registry_skills(home=tmp_path)
    assert [skill.name for skill in skills] == ["demo", "jupyter-notebook", "notion-research-documentation", "pdf", "transcribe"]


def test_search_registry_skills_matches_name_and_description(tmp_path):
    registry_file = tmp_path / "skills.json"
    registry_file.write_text(
        json.dumps(
            {
                "version": 1,
                "skills": [
                    {
                        "name": "paper-helper",
                        "source": "github:example/paper/skills/helper",
                        "description": "Academic writing helper",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    add_registry_source("local", str(registry_file), home=tmp_path)
    update_registry_cache(home=tmp_path)

    assert [skill.name for skill in search_registry_skills("academic", home=tmp_path)] == ["paper-helper"]
