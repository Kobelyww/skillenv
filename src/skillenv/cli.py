from pathlib import Path

import typer

from skillenv import __version__
from skillenv.envs import create_env, get_env, list_envs, remove_env
from skillenv.install import install_github_skill, install_local_skill, parse_github_source
from skillenv.manifest import export_manifest, load_manifest_file, parse_inline_list, render_manifest
from skillenv.plugin_adapter import create_codex_plugin_adapter
from skillenv.presets import get_preset, list_presets
from skillenv.registry import get_registry_skill, list_registry_skills
from skillenv.runner import run_command

app = typer.Typer(help="Manage isolated agent skill environments.", no_args_is_help=True)
env_app = typer.Typer(help="Inspect and manage environments.", no_args_is_help=True)
preset_app = typer.Typer(help="Inspect built-in environment presets.", no_args_is_help=True)
registry_app = typer.Typer(help="Inspect the bundled skill registry.", no_args_is_help=True)
adapter_app = typer.Typer(help="Generate agent adapter artifacts.", no_args_is_help=True)
app.add_typer(env_app, name="env")
app.add_typer(preset_app, name="preset")
app.add_typer(registry_app, name="registry")
app.add_typer(adapter_app, name="adapter")


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
) -> None:
    """Create an isolated Codex skill environment."""
    if file is not None:
        manifest_name, manifest_text = load_manifest_file(file)
        env = create_env(manifest_name)
        (env.root / "skillenv.yml").write_text(manifest_text, encoding="utf-8")
        for skill_source in parse_inline_list(manifest_text, "skills"):
            install_skill_source(env, skill_source, force=True)
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
    return install_local_skill(env, Path(source), force=force)


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


@adapter_app.command("codex")
def adapter_codex_command(out: Path = typer.Option(Path("plugins"), "--out", help="Parent directory for the adapter plugin.")) -> None:
    """Create a Codex plugin adapter for skillenv."""
    plugin_root = create_codex_plugin_adapter(out)
    typer.echo(f"created skillenv-codex: {plugin_root}")


if __name__ == "__main__":
    app()
