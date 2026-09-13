import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addRegistrySource, getRegistrySkill, listRegistrySkills, listRegistrySources, parseRegistryPayload, searchRegistrySkills, updateRegistryCache } from "../src/registry.js";
import { loadBundledRegistry } from "../src/registry.js";
import { useTempHome } from "./helpers.js";

describe("bundled registry", () => {
  it("loads and exposes versioned skills", () => {
    const payload = loadBundledRegistry();
    expect(payload.version).toBe(2);
    const pdf = payload.skills.find((skill) => skill.name === "pdf");
    expect(pdf?.versions?.["1.0.0"]?.source).toBe("github:openai/skills/skills/.curated/pdf");
  });
});

describe("parseRegistryPayload", () => {
  it("normalizes v1 flat entries", () => {
    const payload = parseRegistryPayload(
      JSON.stringify({ version: 1, skills: [{ name: "x", source: "local:/x", description: "d" }] }),
    );
    const skill = payload.skills[0];
    expect(skill?.name).toBe("x");
    expect(skill?.source).toBe("local:/x");
    expect(skill?.versions).toBeUndefined();
  });

  it("rejects registry source names that would escape the cache dir", () => {
    const home = useTempHome()();
    expect(() => addRegistrySource("../../../tmp/evil", "https://example.com/r.json", home)).toThrow(
      "path separators",
    );
    expect(() => addRegistrySource("..", "https://example.com/r.json", home)).toThrow("'..'");
    expect(() => addRegistrySource("a/b", "https://example.com/r.json", home)).toThrow(
      "path separators",
    );
    expect(listRegistrySources(home)).toEqual([]);
  });

  it("rejects payloads without skills", () => {
    expect(() => parseRegistryPayload("{}")).toThrow("'skills' array");
  });
});

describe("user registry sources and cache", () => {
  it("adds, lists, updates and searches sources", async () => {
    const home = useTempHome()();
    expect(listRegistrySources(home)).toEqual([]);

    const remote = mkdtempSync(path.join(tmpdir(), "reg-"));
    const remoteFile = path.join(remote, "team.json");
    writeFileSync(
      remoteFile,
      JSON.stringify({
        version: 2,
        skills: [
          { name: "team-lint", description: "Team lint rules", versions: { "0.1.0": { source: "local:/team/lint" } } },
          { name: "pdf", description: "Overridden PDF", versions: { "9.9.9": { source: "local:/team/pdf" } } },
        ],
      }),
      "utf8",
    );

    addRegistrySource("team", remoteFile, home);
    expect(listRegistrySources(home)).toEqual([{ name: "team", url: remoteFile }]);

    // A broken source degrades to a warning; good sources still update.
    addRegistrySource("broken", "/nonexistent/registry-xyz.json", home);
    const outcome = await updateRegistryCache(home);
    expect(outcome.updated).toEqual(["team"]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]?.name).toBe("broken");

    rmSync(path.join(home, "registry-cache"), { recursive: true, force: true });
    expect((await updateRegistryCache(home)).updated).toEqual(["team"]);
    const skills = listRegistrySkills(home);
    const teamLint = skills.find((skill) => skill.name === "team-lint");
    expect(teamLint?.versions?.["0.1.0"]?.source).toBe("local:/team/lint");
    // Later payloads override bundled entries by name.
    expect(skills.find((skill) => skill.name === "pdf")?.versions?.["9.9.9"]).toBeDefined();

    expect(searchRegistrySkills("lint", home).map((skill) => skill.name)).toEqual(["team-lint"]);
    expect(getRegistrySkill("pdf", home).description).toBe("Overridden PDF");
    expect(() => getRegistrySkill("nope", home)).toThrow("registry skill not found: nope");

    // Re-adding replaces the source (broken remains until removed).
    addRegistrySource("team", remoteFile, home);
    expect(listRegistrySources(home).filter((source) => source.name === "team")).toHaveLength(1);
    expect(listRegistrySources(home)).toHaveLength(2);
  });
});

describe("registry directory scaffold", () => {
  it("exposes the bundled registry file inside the package", () => {
    mkdirSync(path.join(tmpdir(), "noop-registry"), { recursive: true });
    expect(loadBundledRegistry().skills.length).toBeGreaterThan(0);
  });
});
