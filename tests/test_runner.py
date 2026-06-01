from pathlib import Path

from skillenv.envs import create_env
from skillenv.runner import build_run_env


def test_build_run_env_sets_codex_home(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    run_env = build_run_env(env, base={"PATH": "/bin"})

    assert run_env["CODEX_HOME"] == str(env.root)
    assert run_env["PATH"] == "/bin"
