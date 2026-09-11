import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishSkill } from "../src/publish.js";
import { useTempHome } from "./helpers.js";

const HOME = mkdtempSync(path.join(tmpdir(), "publish-"));

function makeSkillDir(name: string, frontmatter: string): string {
  const dir = path.join(HOME, `pub-${Math.random().toString(36).slice(2, 6)}`, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n`, "utf8");
  return dir;
}

describe("publishSkill", () => {
  it("builds a versioned entry from valid frontmatter", () => {
    const dir = makeSkillDir("good", "name: good\ndescription: A good skill\nversion: 1.2.3");
    const { entry, warnings } = publishSkill(dir, { source: "github:o/r/good@v1.2.3" });
    expect(warnings).toEqual([]);
    expect(entry.name).toBe("good");
    expect(entry.versions["1.2.3"]?.source).toBe("github:o/r/good@v1.2.3");
  });

  it("accepts an explicit published source", () => {
    const dir = makeSkillDir("sourced", "name: sourced\ndescription: d\nversion: 0.1.0");
    const { entry, warnings } = publishSkill(dir, { source: "github:o/r/skills/sourced@v0.1.0" });
    expect(warnings).toEqual([]);
    expect(entry.versions["0.1.0"]?.source).toBe("github:o/r/skills/sourced@v0.1.0");
  });

  it("supports dependencies on the published version", () => {
    const dir = makeSkillDir("deppy", "name: deppy\ndescription: d\nversion: 1.0.0");
    const { entry } = publishSkill(dir, { dependencies: ["base@^1"] });
    expect(entry.versions["1.0.0"]?.dependencies).toEqual(["base@^1"]);
  });

  it("rejects missing frontmatter fields and bad semver", () => {
    expect(() => publishSkill(makeSkillDir("nover", "name: nover\ndescription: d"))).toThrow(
      "missing 'version'",
    );
    expect(() =>
      publishSkill(makeSkillDir("badver", "name: badver\ndescription: d\nversion: latest")),
    ).toThrow("not valid semver");
    expect(() => publishSkill(makeSkillDir("nodesc", "name: nodesc\nversion: 1.0.0"))).toThrow(
      "missing 'description'",
    );
  });

  it("upserts into a registry file, sorted by name", () => {
    const home = useTempHome()();
    const registryFile = path.join(home, "team-registry.json");
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 2,
        skills: [{ name: "aaa", description: "first", versions: { "1.0.0": { source: "local:/aaa" } } }],
      }),
      "utf8",
    );

    const dir = makeSkillDir("zzz", "name: zzz\ndescription: last\nversion: 2.0.0");
    const { entry } = publishSkill(dir, { registry: registryFile, source: "github:o/r/zzz@v2.0.0" });
    expect(entry.name).toBe("zzz");

    const payload = JSON.parse(readFileSync(registryFile, "utf8")) as {
      skills: { name: string }[];
    };
    expect(payload.skills.map((skill) => skill.name)).toEqual(["aaa", "zzz"]);

    // Republishing the same name replaces the entry.
    publishSkill(dir, { registry: registryFile, source: "github:o/r/zzz@v2.1.0" }).entry;
    const second = JSON.parse(readFileSync(registryFile, "utf8")) as {
      skills: { name: string; versions: Record<string, unknown> }[];
    };
    expect(second.skills).toHaveLength(2);
    expect(Object.keys(second.skills[1]?.versions ?? {})).toEqual(["2.0.0"]);
  });

  it("warns when the skill name differs from the directory", () => {
    const dir = makeSkillDir("mismatch-dir", "name: mismatch\ndescription: d\nversion: 1.0.0");
    const { warnings } = publishSkill(dir);
    expect(warnings.some((warning) => warning.includes("differs from directory name"))).toBe(true);
  });

  it("rejects directories that are not skills", () => {
    const notSkill = path.join(HOME, "empty-dir");
    mkdirSync(notSkill, { recursive: true });
    expect(() => publishSkill(notSkill)).toThrow("not a skill directory");
    expect(existsSync(path.join(HOME, "ghost"))).toBe(false);
  });
});
