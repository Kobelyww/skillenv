import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addPluginRecord, addSkillRecord, directoryChecksum, readLock, writeLock, utcNow } from "../src/lock.js";

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `lock-${prefix}-`));
}

function makeTree(prefix: string): string {
  const root = tempDir(prefix);
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "one.txt"), "one", "utf8");
  writeFileSync(path.join(root, "sub", "two.txt"), "two", "utf8");
  return root;
}

describe("directoryChecksum", () => {
  it("is stable across identical trees", () => {
    expect(directoryChecksum(makeTree("a"))).toBe(directoryChecksum(makeTree("b")));
  });

  it("changes when contents change", () => {
    const root = makeTree("c");
    const before = directoryChecksum(root);
    writeFileSync(path.join(root, "one.txt"), "changed", "utf8");
    expect(directoryChecksum(root)).not.toBe(before);
  });

  it("has sha256 prefix", () => {
    expect(directoryChecksum(makeTree("d"))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("readLock / writeLock", () => {
  it("returns a default lock when absent", () => {
    const root = tempDir("missing");
    expect(readLock(root)).toEqual({ version: 2, skills: [], plugins: [] });
  });

  it("round-trips and keeps entries sorted", () => {
    const root = tempDir("roundtrip");
    writeLock(root, {
      version: 2,
      skills: [
        { name: "zeta", source: "local:/tmp/zeta", installed_at: utcNow() },
        { name: "alpha", source: "local:/tmp/alpha", installed_at: utcNow() },
      ],
      plugins: [],
    });
    const text = readFileSync(path.join(root, "lock.json"), "utf8");
    expect(text.indexOf("alpha")).toBeLessThan(text.indexOf("zeta"));
    expect(readLock(root).skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
  });

  it("throws on corrupt JSON", () => {
    const root = tempDir("corrupt");
    writeFileSync(path.join(root, "lock.json"), "{not json", "utf8");
    expect(() => readLock(root)).toThrow("not valid JSON");
  });
});

describe("addSkillRecord", () => {
  it("records checksum and replaces by name", () => {
    const root = makeTree("record");
    mkdirSync(path.join(root, "skills", "one"), { recursive: true });
    addSkillRecord(root, { name: "one", source: "local:/x", version: "1.2.3" });
    addSkillRecord(root, { name: "one", source: "local:/y" });
    const lock = readLock(root);
    expect(lock.skills).toHaveLength(1);
    const skill = lock.skills[0] as { name: string; source: string; checksum?: string; version?: string };
    expect(skill.source).toBe("local:/y");
    expect(skill.checksum).toMatch(/^sha256:/);
    expect(skill.version).toBeUndefined();
  });
});

describe("addPluginRecord", () => {
  it("replaces by name and sorts", () => {
    const root = tempDir("plugins");
    addPluginRecord(root, "b", "b");
    addPluginRecord(root, "a", "a");
    addPluginRecord(root, "a", "a2");
    const lock = readLock(root);
    expect(lock.plugins.map((plugin) => plugin.name)).toEqual(["a", "b"]);
    expect(lock.plugins[0]?.source).toBe("a2");
  });
});
