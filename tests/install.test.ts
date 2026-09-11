import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installGitHubSkill, installLocalSkill, parseGitHubSource, parseSourceSpec } from "../src/install.js";
import { readLock } from "../src/lock.js";
import { createEnv } from "../src/env.js";
import { makeSkill } from "./helpers.js";

const HOME = mkdtempSync(path.join(tmpdir(), "install-"));

describe("parseGitHubSource", () => {
  it("parses owner/repo/path with default ref", () => {
    const source = parseGitHubSource("github:openai/skills/skills/.curated/pdf");
    expect(source).toEqual({
      kind: "github",
      owner: "openai",
      repo: "skills",
      path: "skills/.curated/pdf",
      ref: "main",
    });
  });

  it("parses explicit refs including tags with dots", () => {
    const source = parseGitHubSource("github:o/r/path/to/skill@v1.2.3");
    expect(source.ref).toBe("v1.2.3");
    expect(source.path).toBe("path/to/skill");
  });

  it("rejects malformed sources", () => {
    expect(() => parseGitHubSource("github:o/r")).toThrow("github:owner/repo/path");
    expect(() => parseGitHubSource("github:o/r/skill@")).toThrow("ref cannot be empty");
    expect(() => parseGitHubSource("https://example.com")).toThrow("github:");
  });
});

describe("parseSourceSpec", () => {
  it("detects local paths and prefixes", () => {
    expect(parseSourceSpec("github:o/r/p")?.kind).toBe("github");
    const local = parseSourceSpec(import.meta.dirname);
    expect(local?.kind).toBe("local");
    expect(parseSourceSpec("definitely-not-a-path-xyz")).toBeNull();
  });
});

describe("installLocalSkill", () => {
  it("copies the skill and records it in the lock", () => {
    const env = createEnv("local-env", HOME);
    const skillDir = makeSkill(HOME, "my-skill", { description: "demo" });
    const name = installLocalSkill(env.root, skillDir);
    expect(name).toBe("my-skill");
    expect(existsSync(path.join(env.root, "skills", "my-skill", "SKILL.md"))).toBe(true);
    const lock = readLock(env.root);
    expect(lock.skills[0]?.name).toBe("my-skill");
    expect(lock.skills[0]?.source).toBe(`local:${skillDir}`);
    expect(lock.skills[0]?.checksum).toMatch(/^sha256:/);
    expect(lock.skills[0]?.version).toBeUndefined();
  });

  it("records the frontmatter version when present", () => {
    const env = createEnv("versioned-env", HOME);
    const skillDir = makeSkill(HOME, "versioned", { version: "2.3.4" });
    installLocalSkill(env.root, skillDir);
    expect(readLock(env.root).skills[0]?.version).toBe("2.3.4");
  });

  it("refuses directories without SKILL.md", () => {
    const env = createEnv("plain-env", HOME);
    const notASkill = path.join(HOME, "not-a-skill");
    mkdirSync(notASkill, { recursive: true });
    writeFileSync(path.join(notASkill, "README.md"), "no SKILL.md here", "utf8");
    expect(() => installLocalSkill(env.root, notASkill)).toThrow("not a skill directory");
  });

  it("errors when installed twice without force and overwrites with force", () => {
    const env = createEnv("force-env", HOME);
    const skillDir = makeSkill(HOME, "twice");
    installLocalSkill(env.root, skillDir);
    expect(() => installLocalSkill(env.root, skillDir)).toThrow("already installed");
    installLocalSkill(env.root, skillDir, true);
    expect(readLock(env.root).skills).toHaveLength(1);
  });
});

describe("installGitHubSkill", () => {
  it("uses the injected downloader and validates SKILL.md", async () => {
    const env = createEnv("gh-env", HOME);
    const source = parseGitHubSource("github:o/r/skills/cool@v9");
    const downloaded: string[] = [];
    const name = await installGitHubSkill(env.root, source, false, async (_source, destination) => {
      downloaded.push(destination);
      writeFileSync(path.join(destination, "SKILL.md"), "---\nname: cool\n---\n", "utf8");
    });
    expect(name).toBe("cool");
    expect(downloaded).toEqual([path.join(env.root, "skills", "cool")]);
    expect(readLock(env.root).skills[0]?.source).toBe("github:o/r/skills/cool@v9");
  });

  it("cleans up when the download is not a skill", async () => {
    const env = createEnv("gh-bad", HOME);
    const source = parseGitHubSource("github:o/r/not-skill");
    await expect(
      installGitHubSkill(env.root, source, false, async () => {
        writeFileSync(path.join(env.root, "skills", "not-skill", "junk.txt"), "x", "utf8");
      }),
    ).rejects.toThrow("not a skill");
    expect(existsSync(path.join(env.root, "skills", "not-skill"))).toBe(false);
  });
});
