import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Generated adapter artifacts let an agent *inside* Codex / Claude Code / pi
 * drive skillenv itself: each scaffold is a skill (or plugin) that documents
 * the CLI surface to the host agent.
 */

const SKILLENV_SKILL_BODY = `# skillenv

Use the local \`skillenv\` CLI to manage isolated skill environments.

Common commands:

\`\`\`bash
skillenv create research --preset research
skillenv install research github:openai/skills/skills/.curated/pdf
skillenv run research -- codex
skillenv export research
\`\`\`
`;

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

export function createCodexPluginAdapter(parent: string): string {
  const pluginRoot = path.join(parent, "skillenv-codex");
  const manifestDir = path.join(pluginRoot, ".codex-plugin");
  const skillDir = path.join(pluginRoot, "skills", "skillenv");
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(skillDir, { recursive: true });

  const manifest = {
    name: "skillenv-codex",
    version: "2.0.0",
    description: "Codex adapter for skillenv isolated skill environments.",
    author: { name: "skillenv contributors" },
    homepage: "https://github.com/Kobelyww/skillenv",
    repository: "https://github.com/Kobelyww/skillenv",
    license: "MIT",
    skills: "./skills/",
    interface: {
      displayName: "skillenv Codex Adapter",
      shortDescription: "Use skillenv from Codex.",
      longDescription:
        "Provides Codex-facing guidance for creating, running, and exporting isolated skillenv environments.",
      developerName: "skillenv contributors",
      category: "Productivity",
      capabilities: ["Read", "Interactive"],
      defaultPrompt: [
        "Create a research skillenv environment.",
        "Run Codex inside a skillenv environment.",
        "Export my skillenv environment.",
      ],
      brandColor: "#2563EB",
    },
  };
  writeFileSync(path.join(manifestDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    frontmatter(
      "skillenv",
      "Use when the user wants to manage isolated Codex skill environments with skillenv, including creating presets, installing skills, running Codex with CODEX_HOME isolation, or exporting lock-backed manifests.",
    ) + SKILLENV_SKILL_BODY,
    "utf8",
  );
  return pluginRoot;
}

export function createClaudeCodeAdapter(parent: string): string {
  const adapterRoot = path.join(parent, "skillenv-claude-code");
  const skillDir = path.join(adapterRoot, ".claude", "skills", "skillenv");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    frontmatter(
      "skillenv",
      "Use when the user wants to manage isolated agent skill environments with skillenv from Claude Code, including creating presets, installing skills, running commands with CLAUDE_CONFIG_DIR isolation, or exporting lock-backed manifests.",
    ) + SKILLENV_SKILL_BODY,
    "utf8",
  );
  return adapterRoot;
}

export function createPiAdapter(parent: string): string {
  const adapterRoot = path.join(parent, "skillenv-pi");
  const skillDir = path.join(adapterRoot, "skills", "skillenv");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    frontmatter(
      "skillenv",
      "Use when the pi agent should manage isolated skill environments with skillenv: creating environments, installing skills, running pi with PI_CONFIG_DIR isolation, or exporting lock-backed manifests.",
    ) + SKILLENV_SKILL_BODY,
    "utf8",
  );
  return adapterRoot;
}

export function createGeminiAdapter(parent: string): string {
  const adapterRoot = path.join(parent, "skillenv-gemini");
  const skillDir = path.join(adapterRoot, "skills", "skillenv");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    frontmatter(
      "skillenv",
      "Use when the Gemini CLI should manage isolated skill environments with skillenv: creating environments, installing skills, and exporting lock-backed manifests. Experimental: gemini-cli has no config-dir override yet.",
    ) + SKILLENV_SKILL_BODY,
    "utf8",
  );
  return adapterRoot;
}
