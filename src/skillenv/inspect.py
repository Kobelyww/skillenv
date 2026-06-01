from dataclasses import dataclass

from skillenv.envs import Env
from skillenv.lock import read_lock
from skillenv.plugins import list_plugins


@dataclass(frozen=True)
class DoctorResult:
    ok: bool
    issues: list[str]


def describe_env(env: Env) -> dict:
    lock = read_lock(env)
    return {
        "name": env.name,
        "root": str(env.root),
        "skills": [skill["name"] for skill in lock["skills"]],
        "plugins": list_plugins(env),
    }


def check_env(env: Env) -> DoctorResult:
    issues: list[str] = []
    for required_file in ("config.toml", "skillenv.yml"):
        if not (env.root / required_file).exists():
            issues.append(f"missing {required_file}")

    skills_dir = env.root / "skills"
    if not skills_dir.is_dir():
        issues.append("missing skills directory")
    else:
        for skill_dir in sorted(path for path in skills_dir.iterdir() if path.is_dir()):
            if not (skill_dir / "SKILL.md").is_file():
                issues.append(f"missing SKILL.md: skills/{skill_dir.name}")

    return DoctorResult(ok=not issues, issues=issues)
