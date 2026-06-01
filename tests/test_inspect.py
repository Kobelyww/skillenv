from pathlib import Path

from skillenv.envs import create_env
from skillenv.inspect import check_env, describe_env
from skillenv.lock import add_skill_record
from skillenv.plugins import install_plugin


def test_describe_env_reports_core_state(tmp_path: Path):
    env = create_env("research", home=tmp_path)
    add_skill_record(env, name="pdf", source="pdf")
    install_plugin(env, "latex@openai-bundled")

    summary = describe_env(env)

    assert summary["name"] == "research"
    assert summary["root"] == str(env.root)
    assert summary["skills"] == ["pdf"]
    assert summary["plugins"] == ["latex@openai-bundled"]


def test_check_env_passes_for_new_environment(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    result = check_env(env)

    assert result.ok is True
    assert result.issues == []


def test_check_env_reports_missing_skill_file(tmp_path: Path):
    env = create_env("research", home=tmp_path)
    broken_skill = env.root / "skills" / "broken"
    broken_skill.mkdir()

    result = check_env(env)

    assert result.ok is False
    assert "missing SKILL.md: skills/broken" in result.issues
