from pathlib import Path

from skillenv.envs import create_env
from skillenv.inspect import check_env, describe_env, diff_envs
from skillenv.install import install_local_skill
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


def test_check_env_reports_checksum_mismatch(tmp_path: Path):
    skill = tmp_path / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("# Demo\n", encoding="utf-8")
    env = create_env("research", home=tmp_path)

    installed = install_local_skill(env, skill)
    (installed / "SKILL.md").write_text("# Changed\n", encoding="utf-8")

    result = check_env(env)

    assert result.ok is False
    assert "checksum mismatch: skills/demo-skill" in result.issues


def test_diff_envs_reports_skill_and_plugin_differences(tmp_path: Path):
    research = create_env("research", home=tmp_path)
    coding = create_env("coding", home=tmp_path)
    add_skill_record(research, name="pdf", source="pdf")
    add_skill_record(coding, name="openai-docs", source="openai-docs")
    install_plugin(research, "latex@openai-bundled")
    install_plugin(coding, "browser@openai-bundled")

    result = diff_envs(research, coding)

    assert result.left_name == "research"
    assert result.right_name == "coding"
    assert result.skills_only_left == ["pdf"]
    assert result.skills_only_right == ["openai-docs"]
    assert result.plugins_only_left == ["latex@openai-bundled"]
    assert result.plugins_only_right == ["browser@openai-bundled"]
