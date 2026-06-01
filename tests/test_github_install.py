from pathlib import Path

from skillenv.envs import create_env
from skillenv.install import GitHubSkillSource, install_github_skill, parse_github_source
from skillenv.lock import read_lock


def test_parse_github_source_short_form():
    source = parse_github_source("github:openai/skills/skills/.curated/pdf")

    assert source == GitHubSkillSource(
        owner="openai",
        repo="skills",
        path="skills/.curated/pdf",
        ref="main",
    )


def test_install_github_skill_uses_downloader(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    def fake_downloader(source: GitHubSkillSource, destination: Path) -> None:
        destination.mkdir()
        (destination / "SKILL.md").write_text("---\nname: pdf\n---\n# PDF\n", encoding="utf-8")

    installed = install_github_skill(
        env,
        GitHubSkillSource(owner="openai", repo="skills", path="skills/.curated/pdf", ref="main"),
        downloader=fake_downloader,
    )

    assert installed == env.root / "skills" / "pdf"
    assert (installed / "SKILL.md").is_file()
    record = read_lock(env)["skills"][0]
    assert record["name"] == "pdf"
    assert record["source"] == "github:openai/skills/skills/.curated/pdf@main"
    assert record["installed_at"].endswith("Z")
    assert record["checksum"].startswith("sha256:")
