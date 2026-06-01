from pathlib import Path

from skillenv.plugin_adapter import create_codex_plugin_adapter


def test_create_codex_plugin_adapter_writes_manifest_and_skill(tmp_path: Path):
    plugin_root = create_codex_plugin_adapter(tmp_path)

    assert (plugin_root / ".codex-plugin" / "plugin.json").is_file()
    assert (plugin_root / "skills" / "skillenv" / "SKILL.md").is_file()
    assert "skillenv" in (plugin_root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")
