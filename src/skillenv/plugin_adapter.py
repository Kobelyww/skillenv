import json
from pathlib import Path


def create_codex_plugin_adapter(parent: Path) -> Path:
    plugin_root = parent / "skillenv-codex"
    manifest_dir = plugin_root / ".codex-plugin"
    skill_dir = plugin_root / "skills" / "skillenv"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "name": "skillenv-codex",
        "version": "0.1.0",
        "description": "Codex adapter for skillenv isolated skill environments.",
        "author": {"name": "skillenv contributors"},
        "homepage": "https://github.com/skillenv/skillenv",
        "repository": "https://github.com/skillenv/skillenv",
        "license": "MIT",
        "skills": "./skills/",
        "interface": {
            "displayName": "skillenv Codex Adapter",
            "shortDescription": "Use skillenv from Codex.",
            "longDescription": "Provides Codex-facing guidance for creating, running, and exporting isolated skillenv environments.",
            "developerName": "skillenv contributors",
            "category": "Productivity",
            "capabilities": ["Read", "Interactive"],
            "defaultPrompt": [
                "Create a research skillenv environment.",
                "Run Codex inside a skillenv environment.",
                "Export my skillenv environment."
            ],
            "brandColor": "#2563EB"
        },
    }
    (manifest_dir / "plugin.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (skill_dir / "SKILL.md").write_text(
        """---
name: skillenv
description: Use when the user wants to manage isolated Codex skill environments with skillenv, including creating presets, installing skills, running Codex with CODEX_HOME isolation, or exporting lock-backed manifests.
---

# skillenv

Use the local `skillenv` CLI to manage isolated skill environments.

Common commands:

```bash
skillenv create research --preset research
skillenv install research github:openai/skills/skills/.curated/pdf
skillenv run research -- codex
skillenv export research
```

If the editable console script cannot import the package during development, use:

```bash
PYTHONPATH=src python -m skillenv --help
```
""",
        encoding="utf-8",
    )
    return plugin_root
