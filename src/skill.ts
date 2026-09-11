import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

/**
 * Optional frontmatter of a `SKILL.md` file. All fields are optional because
 * bare skill directories without frontmatter are still valid skills.
 */
export interface SkillMeta {
  name?: string;
  description?: string;
  version?: string;
  /** Specs this skill needs, as `name` or `name@range`. */
  dependencies?: string[];
}

export const SKILL_FILE = "SKILL.md";

export function isSkillDir(dir: string): boolean {
  try {
    return readFileSync(path.join(dir, SKILL_FILE), "utf8").length >= 0;
  } catch {
    return false;
  }
}

/** Extract and parse the YAML frontmatter block of a SKILL.md file. */
export function readSkillMeta(skillDir: string): SkillMeta {
  let text: string;
  try {
    text = readFileSync(path.join(skillDir, SKILL_FILE), "utf8");
  } catch {
    return {};
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return {};
  }
  try {
    const data = parse(match[1] ?? "");
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }
    const map = data as Record<string, unknown>;
    const meta: SkillMeta = {};
    if (typeof map.name === "string") meta.name = map.name;
    if (typeof map.description === "string") meta.description = map.description;
    if (typeof map.version === "string") meta.version = map.version;
    if (Array.isArray(map.dependencies)) {
      meta.dependencies = map.dependencies
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    return meta;
  } catch {
    return {};
  }
}
