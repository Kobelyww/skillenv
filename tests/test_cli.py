from typer.testing import CliRunner

import skillenv.cli as cli_module
from skillenv.cli import app
from skillenv.install import GitHubSkillSource


def test_version_command_prints_version():
    result = CliRunner().invoke(app, ["version"])
    assert result.exit_code == 0
    assert "skillenv" in result.stdout


def test_create_and_env_list_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()

    create_result = runner.invoke(app, ["create", "research"])
    list_result = runner.invoke(app, ["env", "list"])

    assert create_result.exit_code == 0
    assert "created research" in create_result.stdout
    assert list_result.exit_code == 0
    assert "research" in list_result.stdout


def test_env_info_command_prints_summary(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])
    runner.invoke(app, ["plugin", "install", "research", "latex@openai-bundled"])

    result = runner.invoke(app, ["env", "info", "research"])

    assert result.exit_code == 0
    assert "name: research" in result.stdout
    assert "plugins: latex@openai-bundled" in result.stdout


def test_doctor_command_reports_ok_for_healthy_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    result = runner.invoke(app, ["doctor", "research"])

    assert result.exit_code == 0
    assert "OK research" in result.stdout


def test_doctor_command_fails_for_missing_skill_file(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])
    broken_skill = tmp_path / "envs" / "research" / "skills" / "broken"
    broken_skill.mkdir()

    result = runner.invoke(app, ["doctor", "research"])

    assert result.exit_code == 1
    assert "missing SKILL.md: skills/broken" in result.stdout


def test_install_command_copies_local_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    skill = tmp_path / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n", encoding="utf-8")
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    result = runner.invoke(app, ["install", "research", str(skill)])

    assert result.exit_code == 0
    assert "installed demo-skill" in result.stdout
    assert (tmp_path / "home" / "envs" / "research" / "skills" / "demo-skill" / "SKILL.md").is_file()


def test_export_includes_installed_local_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    skill = tmp_path / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n", encoding="utf-8")
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])
    runner.invoke(app, ["install", "research", str(skill)])

    result = runner.invoke(app, ["export", "research"])

    assert result.exit_code == 0
    assert "local:" in result.stdout
    assert "demo-skill" in result.stdout


def test_export_prints_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    result = runner.invoke(app, ["export", "research"])

    assert result.exit_code == 0
    assert "name: research" in result.stdout
    assert "adapter: codex" in result.stdout


def test_run_command_sets_codex_home(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    result = runner.invoke(
        app,
        [
            "run",
            "research",
            "--",
            "python",
            "-c",
            "import os; raise SystemExit(0 if os.environ['CODEX_HOME'].endswith('/envs/research') else 9)",
        ],
    )

    assert result.exit_code == 0


def test_create_from_manifest_file(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    manifest = tmp_path / "skillenv.yml"
    manifest.write_text("name: writing\nadapter: codex\nskills: []\nplugins: []\n", encoding="utf-8")
    runner = CliRunner()

    result = runner.invoke(app, ["create", "-f", str(manifest)])

    assert result.exit_code == 0
    assert "created writing" in result.stdout
    assert (tmp_path / "home" / "envs" / "writing" / "skillenv.yml").read_text(encoding="utf-8") == manifest.read_text(encoding="utf-8")


def test_create_from_manifest_installs_local_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    skill = tmp_path / "demo-skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: demo\n---\n# Demo\n", encoding="utf-8")
    manifest = tmp_path / "skillenv.yml"
    manifest.write_text(
        f"name: writing\nadapter: codex\nskills: [local:{skill}]\nplugins: []\n",
        encoding="utf-8",
    )

    result = CliRunner().invoke(app, ["create", "-f", str(manifest)])

    assert result.exit_code == 0
    assert (tmp_path / "home" / "envs" / "writing" / "skills" / "demo-skill" / "SKILL.md").is_file()


def test_create_from_manifest_installs_plugin_selector(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    manifest = tmp_path / "skillenv.yml"
    manifest.write_text(
        "name: writing\nadapter: codex\nskills: []\nplugins: [latex@openai-bundled]\n",
        encoding="utf-8",
    )

    result = CliRunner().invoke(app, ["create", "-f", str(manifest)])

    config = tmp_path / "home" / "envs" / "writing" / "config.toml"
    assert result.exit_code == 0
    assert '[plugins."latex@openai-bundled"]' in config.read_text(encoding="utf-8")


def test_preset_list_command():
    result = CliRunner().invoke(app, ["preset", "list"])

    assert result.exit_code == 0
    assert "research" in result.stdout
    assert "coding" in result.stdout


def test_create_with_preset_writes_manifest(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()

    result = runner.invoke(app, ["create", "research-lab", "--preset", "research"])

    manifest = tmp_path / "envs" / "research-lab" / "skillenv.yml"
    assert result.exit_code == 0
    assert "created research-lab" in result.stdout
    assert "pdf" in manifest.read_text(encoding="utf-8")


def test_create_with_preset_can_install_plugin_selectors(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()

    result = runner.invoke(app, ["create", "research-lab", "--preset", "research", "--install-plugins"])

    config = tmp_path / "envs" / "research-lab" / "config.toml"
    assert result.exit_code == 0
    assert '[plugins."latex@openai-bundled"]' in config.read_text(encoding="utf-8")
    assert '[plugins."zotero@openai-curated"]' in config.read_text(encoding="utf-8")


def test_install_command_accepts_github_source(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    def fake_install(env, source: GitHubSkillSource, force=False):
        destination = env.root / "skills" / source.name
        destination.mkdir(parents=True)
        (destination / "SKILL.md").write_text("---\nname: pdf\n---\n# PDF\n", encoding="utf-8")
        return destination

    monkeypatch.setattr(cli_module, "install_github_skill", fake_install)
    result = runner.invoke(app, ["install", "research", "github:openai/skills/skills/.curated/pdf"])

    assert result.exit_code == 0
    assert "installed pdf" in result.stdout


def test_install_command_accepts_registry_skill_name(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path / "home"))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    def fake_install(env, source: GitHubSkillSource, force=False):
        destination = env.root / "skills" / source.name
        destination.mkdir(parents=True)
        (destination / "SKILL.md").write_text("---\nname: pdf\n---\n# PDF\n", encoding="utf-8")
        return destination

    monkeypatch.setattr(cli_module, "install_github_skill", fake_install)
    result = runner.invoke(app, ["install", "research", "pdf"])

    assert result.exit_code == 0
    assert "installed pdf" in result.stdout


def test_registry_list_command():
    result = CliRunner().invoke(app, ["registry", "list"])

    assert result.exit_code == 0
    assert "pdf" in result.stdout
    assert "github:openai/skills/skills/.curated/pdf" in result.stdout


def test_registry_show_command():
    result = CliRunner().invoke(app, ["registry", "show", "pdf"])

    assert result.exit_code == 0
    assert "Read, inspect" in result.stdout


def test_registry_search_command():
    result = CliRunner().invoke(app, ["registry", "search", "notebook"])

    assert result.exit_code == 0
    assert "jupyter-notebook" in result.stdout


def test_registry_add_and_sources_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    registry_file = tmp_path / "skills.json"
    registry_file.write_text('{"version": 1, "skills": []}', encoding="utf-8")
    runner = CliRunner()

    add_result = runner.invoke(app, ["registry", "add", "local", str(registry_file)])
    sources_result = runner.invoke(app, ["registry", "sources"])

    assert add_result.exit_code == 0
    assert "added local" in add_result.stdout
    assert sources_result.exit_code == 0
    assert str(registry_file) in sources_result.stdout


def test_adapter_codex_command_creates_plugin(tmp_path):
    result = CliRunner().invoke(app, ["adapter", "codex", "--out", str(tmp_path)])

    assert result.exit_code == 0
    assert "skillenv-codex" in result.stdout
    assert (tmp_path / "skillenv-codex" / ".codex-plugin" / "plugin.json").is_file()


def test_adapter_claude_code_command_creates_skill(tmp_path):
    result = CliRunner().invoke(app, ["adapter", "claude-code", "--out", str(tmp_path)])

    assert result.exit_code == 0
    assert "skillenv-claude-code" in result.stdout
    assert (tmp_path / "skillenv-claude-code" / ".claude" / "skills" / "skillenv" / "SKILL.md").is_file()


def test_plugin_install_and_list_commands(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])

    install_result = runner.invoke(app, ["plugin", "install", "research", "latex@openai-bundled"])
    list_result = runner.invoke(app, ["plugin", "list", "research"])

    assert install_result.exit_code == 0
    assert "installed latex@openai-bundled" in install_result.stdout
    assert list_result.exit_code == 0
    assert "latex@openai-bundled" in list_result.stdout


def test_export_includes_installed_plugin(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLENV_HOME", str(tmp_path))
    runner = CliRunner()
    runner.invoke(app, ["create", "research"])
    runner.invoke(app, ["plugin", "install", "research", "latex@openai-bundled"])

    result = runner.invoke(app, ["export", "research"])

    assert result.exit_code == 0
    assert "plugins: [latex@openai-bundled]" in result.stdout
