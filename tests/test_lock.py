from pathlib import Path

from skillenv.envs import create_env
from skillenv.lock import add_skill_record, add_plugin_record, read_lock


def test_add_skill_record_writes_lock_file(tmp_path: Path):
    env = create_env("research", home=tmp_path)
    skill_dir = env.root / "skills" / "pdf"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# PDF\n", encoding="utf-8")

    add_skill_record(env, name="pdf", source="local:/tmp/pdf")

    record = read_lock(env)["skills"][0]
    assert record["name"] == "pdf"
    assert record["source"] == "local:/tmp/pdf"
    assert record["installed_at"].endswith("Z")
    assert record["checksum"].startswith("sha256:")


def test_add_plugin_record_writes_installed_at(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    add_plugin_record(env, name="latex@openai-bundled", source="latex@openai-bundled")

    record = read_lock(env)["plugins"][0]
    assert record["name"] == "latex@openai-bundled"
    assert record["source"] == "latex@openai-bundled"
    assert record["installed_at"].endswith("Z")
