from pathlib import Path

from skillenv.envs import create_env, list_envs, remove_env
from skillenv.install import install_local_skill
from skillenv.lock import read_lock


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
    assert read_lock(env)["skills"] == [
        {
            "name": "source-skill",
            "source": f"local:{source.resolve()}",
        }
    ]


def test_remove_env_deletes_environment(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    remove_env("research", home=tmp_path)

    assert not env.root.exists()
