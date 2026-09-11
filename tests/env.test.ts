import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEnv, cloneEnv, getEnv, listEnvs, removeEnv, renameEnv, validateEnvName, rewriteManifestName } from "../src/env.js";
import { useTempHome } from "./helpers.js";

describe("validateEnvName", () => {
  it("rejects empty names", () => {
    expect(() => validateEnvName("")).toThrow("cannot be empty");
  });

  it("rejects path separators and dot names", () => {
    expect(() => validateEnvName("a/b")).toThrow("path separators");
    expect(() => validateEnvName("a\\b")).toThrow("path separators");
    expect(() => validateEnvName(".")).toThrow("'.'");
    expect(() => validateEnvName("..")).toThrow("'..'");
  });

  it("accepts plain names", () => {
    expect(validateEnvName("research-01")).toBe("research-01");
  });
});

describe("createEnv", () => {
  it("creates the standard layout", () => {
    const home = useTempHome()();
    const env = createEnv("demo", home);
    for (const dir of ["skills", "plugins", "sessions", "log"]) {
      expect(statSync(path.join(env.root, dir)).isDirectory()).toBe(true);
    }
    expect(readFileSync(path.join(env.root, "config.toml"), "utf8")).toContain("skillenv managed");
    expect(readFileSync(path.join(env.root, "skillenv.yml"), "utf8")).toContain("name: demo");
    expect(readFileSync(path.join(env.root, "skillenv.yml"), "utf8")).toContain("adapter: codex");
  });

  it("is idempotent and does not clobber existing files", () => {
    const home = useTempHome()();
    const env = createEnv("demo", home);
    const marker = "# custom\n";
    const config = path.join(env.root, "config.toml");
    writeFileSync(config, marker, "utf8");
    createEnv("demo", home);
    expect(readFileSync(config, "utf8")).toBe(marker);
  });

  it("supports a non-default adapter in the scaffolded manifest", () => {
    const home = useTempHome()();
    const env = createEnv("claude-env", home, "claude");
    expect(readFileSync(path.join(env.root, "skillenv.yml"), "utf8")).toContain("adapter: claude");
  });
});

describe("getEnv / listEnvs / removeEnv", () => {
  it("round-trips environments", () => {
    const home = useTempHome()();
    createEnv("a", home);
    createEnv("b", home);
    expect(getEnv("a", home).name).toBe("a");
    expect(listEnvs(home).map((env) => env.name)).toEqual(["a", "b"]);
    removeEnv("a", home);
    expect(listEnvs(home).map((env) => env.name)).toEqual(["b"]);
    expect(existsSync(path.join(home, "envs", "a"))).toBe(false);
  });

  it("throws for missing environments", () => {
    const home = useTempHome()();
    expect(() => getEnv("ghost", home)).toThrow("environment not found: ghost");
    expect(() => removeEnv("ghost", home)).toThrow("environment not found: ghost");
  });
});

describe("cloneEnv", () => {
  it("copies skills, plugins, config and lock, and rewrites the manifest name", () => {
    const home = useTempHome()();
    const source = createEnv("src-env", home);
    mkdirSync(path.join(source.root, "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(source.root, "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n", "utf8");
    writeFileSync(path.join(source.root, "lock.json"), '{"version":2,"skills":[],"plugins":[]}\n', "utf8");

    const target = cloneEnv("src-env", "dst-env", home);
    expect(target.name).toBe("dst-env");
    expect(existsSync(path.join(target.root, "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(target.root, "lock.json"))).toBe(true);
    const manifest = readFileSync(path.join(target.root, "skillenv.yml"), "utf8");
    expect(manifest).toContain("name: dst-env");
    expect(manifest).not.toContain("name: src-env");
    expect(existsSync(path.join(target.root, "sessions"))).toBe(true);
  });

  it("refuses to overwrite an existing target", () => {
    const home = useTempHome()();
    createEnv("a", home);
    createEnv("b", home);
    expect(() => cloneEnv("a", "b", home)).toThrow("already exists");
  });
});

describe("renameEnv", () => {
  it("moves the directory, rewrites the manifest name, and preserves contents", () => {
    const home = useTempHome()();
    const source = createEnv("old-env", home);
    mkdirSync(path.join(source.root, "skills", "pdf"), { recursive: true });
    writeFileSync(path.join(source.root, "skills", "pdf", "SKILL.md"), "---\nname: pdf\n---\n", "utf8");
    writeFileSync(path.join(source.root, "lock.json"), '{"version":2,"skills":[],"plugins":[]}\n', "utf8");

    const renamed = renameEnv("old-env", "new-env", home);
    expect(renamed.name).toBe("new-env");
    expect(renamed.root).toBe(path.join(home, "envs", "new-env"));
    expect(existsSync(path.join(home, "envs", "old-env"))).toBe(false);
    expect(existsSync(path.join(renamed.root, "skills", "pdf", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(renamed.root, "lock.json"))).toBe(true);
    expect(existsSync(path.join(renamed.root, "sessions"))).toBe(true);
    const manifest = readFileSync(path.join(renamed.root, "skillenv.yml"), "utf8");
    expect(manifest).toContain("name: new-env");
    expect(manifest).not.toContain("name: old-env");
  });

  it("throws when the source is missing", () => {
    const home = useTempHome()();
    expect(() => renameEnv("ghost", "new-env", home)).toThrow("environment not found: ghost");
  });

  it("throws when the target already exists", () => {
    const home = useTempHome()();
    createEnv("a", home);
    createEnv("b", home);
    expect(() => renameEnv("a", "b", home)).toThrow("environment already exists: b");
  });

  it("rejects invalid target names", () => {
    const home = useTempHome()();
    createEnv("a", home);
    expect(() => renameEnv("a", "bad/name", home)).toThrow("path separators");
    expect(() => renameEnv("a", "", home)).toThrow("cannot be empty");
  });
});

describe("rewriteManifestName", () => {
  it("rewrites only the name line", () => {
    expect(rewriteManifestName("name: old\nadapter: codex\n", "new")).toBe("name: new\nadapter: codex\n");
  });

  it("prepends a name when missing", () => {
    expect(rewriteManifestName("adapter: codex\n", "new")).toBe("name: new\nadapter: codex\n");
  });
});
