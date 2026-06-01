from pathlib import Path

from skillenv.envs import clone_env, create_env, list_envs, remove_env
from skillenv.install import install_local_skill
from skillenv.lock import read_lock
from skillenv.plugins import install_plugin


def test_create_env_creates_codex_home_layout(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    assert env.name == "research"
    assert env.root == tmp_path / "envs" / "research"
    assert (env.root / "skills").is_dir()
    assert (env.root / "plugins").is_dir()
    assert (env.root / "sessions").is_dir()
    assert (env.root / "log").is_dir()
    assert (env.root / "config.toml").is_file()
    assert (env.root / "skillenv.yml").is_file()


def test_list_envs_returns_existing_envs(tmp_path: Path):
    create_env("research", home=tmp_path)
    create_env("coding", home=tmp_path)

    assert [env.name for env in list_envs(home=tmp_path)] == ["coding", "research"]


def test_install_local_skill_copies_skill_directory(tmp_path: Path):
    source = tmp_path / "source-skill"
    source.mkdir()
    (source / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n", encoding="utf-8")
    env = create_env("research", home=tmp_path)

    installed = install_local_skill(env, source)

    assert installed == env.root / "skills" / "source-skill"
    assert (installed / "SKILL.md").read_text(encoding="utf-8") == "---\nname: demo\n---\n# Demo\n"
    record = read_lock(env)["skills"][0]
    assert record["name"] == "source-skill"
    assert record["source"] == f"local:{source.resolve()}"
    assert record["installed_at"].endswith("Z")
    assert record["checksum"].startswith("sha256:")


def test_remove_env_deletes_environment(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    remove_env("research", home=tmp_path)

    assert not env.root.exists()


def test_clone_env_copies_configuration_and_excludes_history(tmp_path: Path):
    skill = tmp_path / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n", encoding="utf-8")
    source = create_env("research", home=tmp_path)
    install_local_skill(source, skill)
    install_plugin(source, "latex@openai-bundled")
    (source.root / "sessions" / "old.jsonl").write_text("session", encoding="utf-8")
    (source.root / "log" / "old.log").write_text("log", encoding="utf-8")

    cloned = clone_env("research", "research-copy", home=tmp_path)

    assert cloned.name == "research-copy"
    assert (cloned.root / "skills" / "demo-skill" / "SKILL.md").is_file()
    assert (cloned.root / "config.toml").read_text(encoding="utf-8") == (source.root / "config.toml").read_text(encoding="utf-8")
    assert read_lock(cloned) == read_lock(source)
    assert "name: research-copy" in (cloned.root / "skillenv.yml").read_text(encoding="utf-8")
    assert "name: research\n" not in (cloned.root / "skillenv.yml").read_text(encoding="utf-8")
    assert not (cloned.root / "sessions" / "old.jsonl").exists()
    assert not (cloned.root / "log" / "old.log").exists()


def test_clone_env_fails_when_target_exists(tmp_path: Path):
    create_env("research", home=tmp_path)
    create_env("research-copy", home=tmp_path)

    try:
        clone_env("research", "research-copy", home=tmp_path)
    except FileExistsError as exc:
        assert "environment already exists: research-copy" in str(exc)
    else:
        raise AssertionError("clone_env should fail when target exists")
