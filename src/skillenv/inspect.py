from dataclasses import dataclass

from skillenv.envs import Env
from skillenv.lock import read_lock
from skillenv.plugins import list_plugins


@dataclass(frozen=True)
class DoctorResult:
    ok: bool
    issues: list[str]


@dataclass(frozen=True)
class DiffResult:
    left_name: str
    right_name: str
    skills_only_left: list[str]
    skills_only_right: list[str]
    plugins_only_left: list[str]
    plugins_only_right: list[str]


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


def diff_envs(left: Env, right: Env) -> DiffResult:
    left_summary = describe_env(left)
    right_summary = describe_env(right)
    left_skills = set(left_summary["skills"])
    right_skills = set(right_summary["skills"])
    left_plugins = set(left_summary["plugins"])
    right_plugins = set(right_summary["plugins"])
    return DiffResult(
        left_name=left.name,
        right_name=right.name,
        skills_only_left=sorted(left_skills - right_skills),
        skills_only_right=sorted(right_skills - left_skills),
        plugins_only_left=sorted(left_plugins - right_plugins),
        plugins_only_right=sorted(right_plugins - left_plugins),
    )
