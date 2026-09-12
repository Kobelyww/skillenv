import { describe, expect, it } from "vitest";
import {
  isNameSpec,
  parseSkillSpec,
  resolveDependencies,
  type CatalogEntry,
} from "../src/resolve.js";

function catalog(entries: CatalogEntry[]): (name: string) => CatalogEntry | null {
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return (name) => byName.get(name) ?? null;
}

const SIMPLE: CatalogEntry[] = [
  { name: "pdf", versions: { "1.0.0": { source: "github:o/r/pdf@1" }, "1.2.0": { source: "github:o/r/pdf@12" }, "2.0.0": { source: "github:o/r/pdf@2" } } },
  { name: "latex", versions: { "1.1.0": { source: "github:o/r/latex@11" } } },
];

describe("parseSkillSpec", () => {
  it("splits name@range at the first @ after position 0", () => {
    expect(parseSkillSpec("pdf@^1.0")).toEqual({ name: "pdf", range: "^1.0" });
    expect(parseSkillSpec("pdf")).toEqual({ name: "pdf", range: "" });
  });

  it("rejects empty specs", () => {
    expect(() => parseSkillSpec("")).toThrow("cannot be empty");
  });
});

describe("resolveDependencies", () => {
  it("picks the highest satisfying version", () => {
    const { resolved } = resolveDependencies(["pdf"], catalog(SIMPLE));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.version).toBe("2.0.0");
  });

  it("honors range constraints", () => {
    const { resolved } = resolveDependencies(["pdf@^1.0"], catalog(SIMPLE));
    expect(resolved[0]?.version).toBe("1.2.0");
  });

  it("intersects constraints from multiple requirers", () => {
    const entries: CatalogEntry[] = [
      { name: "base", versions: { "1.0.0": { source: "s" }, "1.4.0": { source: "s" }, "2.0.0": { source: "s" } } },
      { name: "a", versions: { "1.0.0": { source: "s", dependencies: ["base@^1.0"] } } },
      { name: "b", versions: { "1.0.0": { source: "s", dependencies: ["base@>=1.2 <2"] } } },
    ];
    const { resolved } = resolveDependencies(["a", "b"], catalog(entries));
    const base = resolved.find((r) => r.name === "base");
    expect(base?.version).toBe("1.4.0");
    expect(base?.requiredBy.sort()).toEqual(["a", "b"]);
  });

  it("reports a conflict naming requirers and versions", () => {
    const entries: CatalogEntry[] = [
      { name: "base", versions: { "1.0.0": { source: "s" }, "2.0.0": { source: "s" } } },
      { name: "a", versions: { "1.0.0": { source: "s", dependencies: ["base@^1.0"] } } },
      { name: "b", versions: { "1.0.0": { source: "s", dependencies: ["base@^2.0"] } } },
    ];
    expect(() => resolveDependencies(["a", "b"], catalog(entries))).toThrow(
      /dependency conflict for 'base'/,
    );
    expect(() => resolveDependencies(["a", "b"], catalog(entries))).toThrow(/a requires \^1\.0/);
  });

  it("installs transitive dependencies topologically", () => {
    const entries: CatalogEntry[] = [
      { name: "pdf-core", versions: { "1.0.0": { source: "core-src" } } },
      { name: "pdf", versions: { "1.0.0": { source: "pdf-src", dependencies: ["pdf-core@^1"] } } },
    ];
    const { resolved } = resolveDependencies(["pdf"], catalog(entries));
    expect(resolved.map((r) => r.name)).toEqual(["pdf-core", "pdf"]);
  });

  it("tolerates dependency cycles", () => {
    const entries: CatalogEntry[] = [
      { name: "a", versions: { "1.0.0": { source: "s", dependencies: ["b@*"] } } },
      { name: "b", versions: { "1.0.0": { source: "s", dependencies: ["a@*"] } } },
    ];
    const { resolved } = resolveDependencies(["a"], catalog(entries));
    expect(resolved).toHaveLength(2);
  });

  it("errors for unknown skills naming the requirer", () => {
    expect(() => resolveDependencies(["ghost"], catalog(SIMPLE))).toThrow(
      "skill not found in registry: ghost (required by manifest)",
    );
  });

  it("warns when ranges cannot be verified against unversioned entries", () => {
    const entries: CatalogEntry[] = [
      { name: "plain", versions: {}, unversioned: { source: "local:/plain" } },
    ];
    const { resolved, warnings } = resolveDependencies(["plain@^1.0"], catalog(entries));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.version).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no versions");
  });

  it("handles deep chains with pinned ranges", () => {
    const entries: CatalogEntry[] = [
      { name: "z", versions: { "1.0.0": { source: "s" }, "1.5.0": { source: "s" }, "2.0.0": { source: "s" } } },
      { name: "y", versions: { "1.0.0": { source: "s", dependencies: ["z@~1.5"] } } },
      { name: "x", versions: { "1.0.0": { source: "s", dependencies: ["y@^1", "z@<2"] } } },
    ];
    const { resolved } = resolveDependencies(["x"], catalog(entries));
    expect(resolved.map((r) => r.name)).toEqual(["z", "y", "x"]);
    expect(resolved.find((r) => r.name === "z")?.version).toBe("1.5.0");
  });
});

describe("isNameSpec", () => {
  it("distinguishes names from sources", () => {
    expect(isNameSpec("pdf")).toBe(true);
    expect(isNameSpec("pdf@^1")).toBe(true);
    expect(isNameSpec("github:o/r/pdf")).toBe(false);
    expect(isNameSpec("local:/tmp/pdf")).toBe(false);
    expect(isNameSpec("./skills/pdf")).toBe(false);
    expect(isNameSpec("C:\\Users\\me\\skills\\pdf")).toBe(false);
    expect(isNameSpec("skills\\pdf")).toBe(false);
  });
});
