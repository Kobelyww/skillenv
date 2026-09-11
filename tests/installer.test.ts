import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installSpecs, toCatalogEntry } from "../src/installer.js";
import { createEnv } from "../src/env.js";
import { readLock } from "../src/lock.js";
import { addRegistrySource, updateRegistryCache } from "../src/registry.js";
import { useTempHome } from "./helpers.js";

describe("toCatalogEntry", () => {
  it("maps versioned and unversioned registry entries", () => {
    const versioned = toCatalogEntry({
      name: "a",
      description: "",
      versions: { "1.0.0": { source: "s", dependencies: ["b@^1"] } },
    });
    expect(versioned.versions["1.0.0"]?.dependencies).toEqual(["b@^1"]);

    const flat = toCatalogEntry({ name: "b", description: "", source: "local:/b" });
    expect(flat.unversioned?.source).toBe("local:/b");
    expect(Object.keys(flat.versions)).toHaveLength(0);
  });
});

describe("installSpecs with registry resolution", () => {
  it("resolves a versioned registry skill with transitive deps from a file source", async () => {
    const home = useTempHome()();
    const env = createEnv("resolver-env", home);

    const skillsRoot = mkdtempSync(path.join(tmpdir(), "skills-"));
    makeRegistrySkill(skillsRoot, "pdf-core", "1.0.0");
    makeRegistrySkill(skillsRoot, "pdf", "2.1.0", ["pdf-core@^1"]);
    const registryFile = path.join(skillsRoot, "registry.json");
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 2,
        skills: [
          {
            name: "pdf",
            description: "PDF toolkit",
            versions: { "2.1.0": { source: `local:${path.join(skillsRoot, "pdf")}`, dependencies: ["pdf-core@^1"] } },
          },
          {
            name: "pdf-core",
            description: "Core",
            versions: { "1.0.0": { source: `local:${path.join(skillsRoot, "pdf-core")}` } },
          },
        ],
      }),
      "utf8",
    );
    addRegistrySource("test", registryFile, home);
    await updateRegistryCache(home);

    const outcome = await installSpecs(env.root, home, ["pdf@^2"]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.installed.map((skill) => skill.name)).toEqual(["pdf-core", "pdf"]);

    expect(existsSync(path.join(env.root, "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(env.root, "skills", "pdf-core", "SKILL.md"))).toBe(true);

    const lock = readLock(env.root);
    const pdf = lock.skills.find((skill) => skill.name === "pdf");
    const core = lock.skills.find((skill) => skill.name === "pdf-core");
    expect(pdf?.version).toBe("2.1.0");
    expect(pdf?.dependencies).toEqual(["pdf-core@^1"]);
    expect(core?.version).toBe("1.0.0");
  });

  it("installs direct local paths beside registry names", async () => {
    const home = useTempHome()();
    const env = createEnv("mixed-env", home);
    const skillDir = mkdtempSync(path.join(tmpdir(), "direct-"));
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: local-one\n---\nbody", "utf8");

    const outcome = await installSpecs(env.root, home, [skillDir]);
    expect(outcome.installed[0]?.name).toBe(path.basename(skillDir));
    expect(existsSync(path.join(env.root, "skills", path.basename(skillDir), "SKILL.md"))).toBe(true);
  });

  it("propagates conflict errors", async () => {
    const home = useTempHome()();
    const env = createEnv("conflict-env", home);
    const skillsRoot = mkdtempSync(path.join(tmpdir(), "conf-"));
    makeRegistrySkill(skillsRoot, "base", "1.0.0");
    makeRegistrySkill(skillsRoot, "base", "2.0.0");
    makeRegistrySkill(skillsRoot, "a", "1.0.0", ["base@^1"]);
    makeRegistrySkill(skillsRoot, "b", "1.0.0", ["base@^2"]);
    const registryFile = path.join(skillsRoot, "registry.json");
    writeFileSync(
      registryFile,
      JSON.stringify({
        version: 2,
        skills: [
          { name: "a", description: "", versions: { "1.0.0": { source: `local:${path.join(skillsRoot, "a")}`, dependencies: ["base@^1"] } } },
          { name: "b", description: "", versions: { "1.0.0": { source: `local:${path.join(skillsRoot, "b")}`, dependencies: ["base@^2"] } } },
          {
            name: "base",
            description: "",
            versions: {
              "1.0.0": { source: `local:${path.join(skillsRoot, "base")}` },
              "2.0.0": { source: `local:${path.join(skillsRoot, "base")}` },
            },
          },
        ],
      }),
      "utf8",
    );
    addRegistrySource("conflict", registryFile, home);
    await updateRegistryCache(home);

    await expect(installSpecs(env.root, home, ["a", "b"])).rejects.toThrow("dependency conflict for 'base'");
  });
});

function makeRegistrySkill(root: string, name: string, _version: string, dependencies?: string[]): void {
  void _version;
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const front = ["---", `name: ${name}`, "---", "", `# ${name}`, ""];
  writeFileSync(path.join(dir, "SKILL.md"), front.join("\n"), "utf8");
}
