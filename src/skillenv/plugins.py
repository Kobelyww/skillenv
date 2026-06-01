from skillenv.envs import Env
from skillenv.lock import add_plugin_record, read_lock


def install_plugin(env: Env, selector: str) -> str:
    config_path = env.root / "config.toml"
    existing = config_path.read_text(encoding="utf-8") if config_path.exists() else ""
    block_header = f'[plugins."{selector}"]'
    if block_header not in existing:
        separator = "\n" if existing.endswith("\n") else "\n\n"
        config_path.write_text(existing + separator + f'{block_header}\nenabled = true\n', encoding="utf-8")
    add_plugin_record(env, name=selector, source=selector)
    return selector


def list_plugins(env: Env) -> list[str]:
    return [plugin["name"] for plugin in read_lock(env)["plugins"]]
