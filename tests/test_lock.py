from pathlib import Path

from skillenv.envs import create_env
from skillenv.lock import add_skill_record, read_lock


def test_add_skill_record_writes_lock_file(tmp_path: Path):
    env = create_env("research", home=tmp_path)

    add_skill_record(env, name="pdf", source="local:/tmp/pdf")

    assert read_lock(env) == {
        "version": 1,
        "skills": [
            {
                "name": "pdf",
                "source": "local:/tmp/pdf",
            }
        ],
        "plugins": [],
    }
