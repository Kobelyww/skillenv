import shutil
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path

from skillenv.envs import Env
from skillenv.lock import add_skill_record


def install_local_skill(env: Env, source: Path, force: bool = False) -> Path:
    source = source.expanduser().resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"skill directory not found: {source}")
    if not (source / "SKILL.md").is_file():
        raise ValueError(f"not a skill directory, missing SKILL.md: {source}")

    destination = env.root / "skills" / source.name
    if destination.exists():
        if not force:
            raise FileExistsError(f"skill already installed: {destination}")
        shutil.rmtree(destination)

    shutil.copytree(source, destination)
    add_skill_record(env, name=destination.name, source=f"local:{source}")
    return destination


@dataclass(frozen=True)
class GitHubSkillSource:
    owner: str
    repo: str
    path: str
    ref: str = "main"

    @property
    def name(self) -> str:
        return Path(self.path).name

    def as_lock_source(self) -> str:
        return f"github:{self.owner}/{self.repo}/{self.path}@{self.ref}"


def parse_github_source(value: str) -> GitHubSkillSource:
    if not value.startswith("github:"):
        raise ValueError("GitHub skill source must start with github:")
    spec = value.removeprefix("github:")
    path_part, separator, ref = spec.partition("@")
    if not separator:
        ref = "main"
    pieces = path_part.split("/")
    if len(pieces) < 3:
        raise ValueError("GitHub skill source must be github:owner/repo/path")
    owner, repo = pieces[0], pieces[1]
    skill_path = "/".join(pieces[2:])
    return GitHubSkillSource(owner=owner, repo=repo, path=skill_path, ref=ref)


def install_github_skill(
    env: Env,
    source: GitHubSkillSource,
    force: bool = False,
    downloader=None,
) -> Path:
    destination = env.root / "skills" / source.name
    if destination.exists():
        if not force:
            raise FileExistsError(f"skill already installed: {destination}")
        shutil.rmtree(destination)

    if downloader is None:
        downloader = download_github_skill
    downloader(source, destination)
    if not (destination / "SKILL.md").is_file():
        shutil.rmtree(destination)
        raise ValueError(f"downloaded GitHub path is not a skill, missing SKILL.md: {source.path}")

    add_skill_record(env, name=destination.name, source=source.as_lock_source())
    return destination


def download_github_skill(source: GitHubSkillSource, destination: Path) -> None:
    url = f"https://github.com/{source.owner}/{source.repo}/archive/{source.ref}.zip"
    with tempfile.TemporaryDirectory() as temp_dir:
        archive = Path(temp_dir) / "repo.zip"
        urllib.request.urlretrieve(url, archive)
        extract_dir = Path(temp_dir) / "repo"
        with zipfile.ZipFile(archive) as zip_file:
            zip_file.extractall(extract_dir)
        roots = [path for path in extract_dir.iterdir() if path.is_dir()]
        if len(roots) != 1:
            raise ValueError(f"unexpected GitHub archive layout for {url}")
        source_dir = roots[0] / source.path
        if not source_dir.is_dir():
            raise FileNotFoundError(f"skill path not found in GitHub archive: {source.path}")
        shutil.copytree(source_dir, destination)
