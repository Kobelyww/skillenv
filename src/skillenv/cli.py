from pathlib import Path

import typer

from skillenv import __version__
from skillenv.envs import create_env, get_env, list_envs, remove_env
from skillenv.inspect import check_env, describe_env, diff_envs
from skillenv.install import install_github_skill, install_local_skill, parse_github_source
from skillenv.manifest import export_manifest, load_manifest_file, parse_inline_list, render_manifest
from skillenv.plugin_adapter import create_claude_code_adapter, create_codex_plugin_adapter
from skillenv.plugins import install_plugin, list_plugins
from skillenv.presets import get_preset, list_presets
from skillenv.registry import (
    add_registry_source,
    get_registry_skill,
    list_registry_skills,
    list_registry_sources,
    search_registry_skills,
    update_registry_cache,
)
from skillenv.runner import run_command

app = typer.Typer(help="Manage isolated agent skill environments.", no_args_is_help=True)
env_app = typer.Typer(help="Inspect and manage environments.", no_args_is_help=True)
preset_app = typer.Typer(help="Inspect built-in environment presets.", no_args_is_help=True)
registry_app = typer.Typer(help="Inspect the bundled skill registry.", no_args_is_help=True)
adapter_app = typer.Typer(help="Generate agent adapter artifacts.", no_args_is_help=True)
plugin_app = typer.Typer(help="Manage environment plugin selectors.", no_args_is_help=True)
app.add_typer(env_app, name="env")
app.add_typer(preset_app, name="preset")
app.add_typer(registry_app, name="registry")
app.add_typer(adapter_app, name="adapter")
app.add_typer(plugin_app, name="plugin")


@app.callback()
def main() -> None:
    """Manage isolated agent skill environments."""


@app.command()
def version() -> None:
    """Print the skillenv version."""
    typer.echo(f"skillenv {__version__}")


@app.command()
def create(
    name: str | None = typer.Argument(None),
    file: Path | None = typer.Option(None, "--file", "-f", help="Create from a skillenv.yml manifest."),
    preset: str | None = typer.Option(None, "--preset", help="Initialize manifest from a built-in preset."),
    install_plugins: bool = typer.Option(False, "--install-plugins", help="Install plugin selectors from the selected preset."),
) -> None:
    """Create an isolated Codex skill environment."""
    if file is not None:
        manifest_name, manifest_text = load_manifest_file(file)
        env = create_env(manifest_name)
        (env.root / "skillenv.yml").write_text(manifest_text, encoding="utf-8")
        for skill_source in parse_inline_list(manifest_text, "skills"):
            install_skill_source(env, skill_source, force=True)
        for plugin_selector in parse_inline_list(manifest_text, "plugins"):
            install_plugin(env, plugin_selector)
        typer.echo(f"created {env.name}: {env.root}")
        return
    if name is None:
        raise typer.BadParameter("environment name is required unless --file is used")
    env = create_env(name)
    if preset is not None:
        selected = get_preset(preset)
        (env.root / "skillenv.yml").write_text(
            render_manifest(env.name, skills=selected.skills, plugins=selected.plugins),
            encoding="utf-8",
        )
        if install_plugins:
            for plugin_selector in selected.plugins:
                install_plugin(env, plugin_selector)
    typer.echo(f"created {env.name}: {env.root}")


@app.command()
def install(env_name: str, source: str, force: bool = False) -> None:
    """Install a local skill directory into an environment."""
    env = get_env(env_name)
    installed = install_skill_source(env, source, force=force)
    typer.echo(f"installed {installed.name}: {installed}")


def install_skill_source(env, source: str, force: bool = False) -> Path:
    if source.startswith("github:"):
        return install_github_skill(env, parse_github_source(source), force=force)
    if source.startswith("local:"):
        return install_local_skill(env, Path(source.removeprefix("local:")), force=force)
    path = Path(source)
    if path.exists():
        return install_local_skill(env, path, force=force)
    try:
        registry_skill = get_registry_skill(source)
    except KeyError:
        return install_local_skill(env, path, force=force)
    return install_skill_source(env, registry_skill.source, force=force)


@app.command("export")
def export_command(env_name: str) -> None:
    """Print an environment manifest."""
    env = get_env(env_name)
    typer.echo(export_manifest(env), nl=False)


@app.command()
def remove(env_name: str) -> None:
    """Remove an isolated skill environment."""
    remove_env(env_name)
    typer.echo(f"removed {env_name}")


@app.command()
def doctor(env_name: str) -> None:
    """Check an environment for common configuration problems."""
    env = get_env(env_name)
    result = check_env(env)
    if result.ok:
        typer.echo(f"OK {env.name}")
        return
    for issue in result.issues:
        typer.echo(issue)
    raise typer.Exit(1)


@app.command("diff")
def diff_command(left_env_name: str, right_env_name: str) -> None:
    """Compare skills and plugins recorded in two environments."""
    left = get_env(left_env_name)
    right = get_env(right_env_name)
    result = diff_envs(left, right)
    print_diff_section(f"skills only in {result.left_name}:", result.skills_only_left)
    print_diff_section(f"skills only in {result.right_name}:", result.skills_only_right)
    print_diff_section(f"plugins only in {result.left_name}:", result.plugins_only_left)
    print_diff_section(f"plugins only in {result.right_name}:", result.plugins_only_right)


def print_diff_section(title: str, items: list[str]) -> None:
    typer.echo(title)
    if not items:
        typer.echo("  -")
        return
    for item in items:
        typer.echo(f"  {item}")


@app.command(
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)
def run(ctx: typer.Context, env_name: str) -> None:
    """Run a command with CODEX_HOME set to an isolated environment."""
    env = get_env(env_name)
    command = list(ctx.args)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise typer.BadParameter("command is required after --")
    raise typer.Exit(run_command(env, command))


@env_app.command("list")
def list_command() -> None:
    """List isolated skill environments."""
    envs = list_envs()
    if not envs:
        typer.echo("no environments")
        return
    for env in envs:
        typer.echo(f"{env.name}\t{env.root}")


@env_app.command("info")
def env_info_command(env_name: str) -> None:
    """Print a summary of one environment."""
    env = get_env(env_name)
    summary = describe_env(env)
    typer.echo(f"name: {summary['name']}")
    typer.echo(f"root: {summary['root']}")
    typer.echo(f"skills: {', '.join(summary['skills']) if summary['skills'] else '-'}")
    typer.echo(f"plugins: {', '.join(summary['plugins']) if summary['plugins'] else '-'}")


@preset_app.command("list")
def preset_list_command() -> None:
    """List built-in environment presets."""
    for name in list_presets():
        preset = get_preset(name)
        typer.echo(f"{preset.name}\t{preset.description}")


@registry_app.command("list")
def registry_list_command() -> None:
    """List bundled registry skills."""
    for skill in list_registry_skills():
        typer.echo(f"{skill.name}\t{skill.source}\t{skill.description}")


@registry_app.command("show")
def registry_show_command(name: str) -> None:
    """Show one bundled registry skill."""
    skill = get_registry_skill(name)
    typer.echo(f"name: {skill.name}")
    typer.echo(f"source: {skill.source}")
    typer.echo(f"description: {skill.description}")


@registry_app.command("search")
def registry_search_command(query: str) -> None:
    """Search bundled and cached registry skills."""
    for skill in search_registry_skills(query):
        typer.echo(f"{skill.name}\t{skill.source}\t{skill.description}")


@registry_app.command("add")
def registry_add_command(name: str, url: str) -> None:
    """Add a local or remote registry source."""
    add_registry_source(name, url)
    typer.echo(f"added {name}: {url}")


@registry_app.command("sources")
def registry_sources_command() -> None:
    """List configured registry sources."""
    sources = list_registry_sources()
    if not sources:
        typer.echo("no registry sources")
        return
    for source in sources:
        typer.echo(f"{source['name']}\t{source['url']}")


@registry_app.command("update")
def registry_update_command() -> None:
    """Refresh configured registry caches."""
    update_registry_cache()
    typer.echo("updated registry cache")


@adapter_app.command("codex")
def adapter_codex_command(out: Path = typer.Option(Path("plugins"), "--out", help="Parent directory for the adapter plugin.")) -> None:
    """Create a Codex plugin adapter for skillenv."""
    plugin_root = create_codex_plugin_adapter(out)
    typer.echo(f"created skillenv-codex: {plugin_root}")


@adapter_app.command("claude-code")
def adapter_claude_code_command(out: Path = typer.Option(Path("adapters"), "--out", help="Parent directory for the Claude Code adapter.")) -> None:
    """Create a Claude Code skill adapter for skillenv."""
    adapter_root = create_claude_code_adapter(out)
    typer.echo(f"created skillenv-claude-code: {adapter_root}")


@plugin_app.command("install")
def plugin_install_command(env_name: str, selector: str) -> None:
    """Record a plugin selector in an environment config."""
    env = get_env(env_name)
    installed = install_plugin(env, selector)
    typer.echo(f"installed {installed}")


@plugin_app.command("list")
def plugin_list_command(env_name: str) -> None:
    """List plugin selectors recorded in an environment."""
    env = get_env(env_name)
    plugins = list_plugins(env)
    if not plugins:
        typer.echo("no plugins")
        return
    for plugin in plugins:
        typer.echo(plugin)


if __name__ == "__main__":
    app()
