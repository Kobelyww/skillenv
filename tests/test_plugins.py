from pathlib import Path

from skillenv.envs import create_env
from skillenv.lock import read_lock
from skillenv.plugins import install_plugin, list_plugins


def test_install_plugin_records_lock_and_config(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    install_plugin(env, "latex@openai-bundled")

    assert read_lock(env)["plugins"] == [
        {
            "name": "latex@openai-bundled",
            "source": "latex@openai-bundled",
        }
    ]
    assert '[plugins."latex@openai-bundled"]' in (env.root / "config.toml").read_text(encoding="utf-8")
    assert "enabled = true" in (env.root / "config.toml").read_text(encoding="utf-8")


def test_list_plugins_reads_lock(tmp_path: Path):
    env = create_env("research", home=tmp_path)
    install_plugin(env, "latex@openai-bundled")

    assert list_plugins(env) == ["latex@openai-bundled"]
