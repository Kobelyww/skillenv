import os
import subprocess

from skillenv.envs import Env


def build_run_env(env: Env, base: dict[str, str] | None = None) -> dict[str, str]:
    run_env = dict(base or os.environ)
    run_env["CODEX_HOME"] = str(env.root)
    return run_env


def run_command(env: Env, command: list[str]) -> int:
    if not command:
        raise ValueError("command cannot be empty")
    completed = subprocess.run(command, env=build_run_env(env), check=False)
    return completed.returncode
