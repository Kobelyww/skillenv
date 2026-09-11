import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnv, describeEnv, diffEnvs } from "../src/inspect.js";
import { createEnv } from "../src/env.js";
import { addSkillRecord, readLock } from "../src/lock.js";
import { installPlugin } from "../src/plugins.js";

const HOME = mkdtempSync(path.join(tmpdir(), "inspect-"));

describe("checkEnv", () => {
  it("passes on a fresh environment", () => {
    const env = createEnv("healthy", HOME);
    expect(checkEnv(env.root, env.name)).toEqual({ ok: true, issues: [] });
  });

  it("detects missing files and skill dirs", () => {
    const env = createEnv("sick", HOME);
    unlinkSync(path.join(env.root, "config.toml"));
    mkdirSync(path.join(env.root, "skills", "broken"), { recursive: true });
    const result = checkEnv(env.root, env.name);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain("missing config.toml");
    expect(result.issues).toContain("missing SKILL.md: skills/broken");
  });

  it("detects checksum mismatches", () => {
    const env = createEnv("tampered", HOME);
    const skillDir = path.join(env.root, "skills", "tampered-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: t\n---\n", "utf8");
    addSkillRecord(env.root, { name: "tampered-skill", source: "local:/x" });
    expect(checkEnv(env.root, env.name).ok).toBe(true);

    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: t\n---\nMODIFIED\n", "utf8");
    const result = checkEnv(env.root, env.name);
    expect(result.issues).toContain("checksum mismatch: skills/tampered-skill");
  });

  it("flags unknown adapters from the manifest", () => {
    const env = createEnv("badadapter", HOME);
    writeFileSync(
      path.join(env.root, "skillenv.yml"),
      "name: badadapter\nadapter: wat\nskills: []\nplugins: []\n",
      "utf8",
    );
    const result = checkEnv(env.root, env.name);
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("unknown adapter: wat");
  });
});

describe("describeEnv / diffEnvs", () => {
  it("summarizes and diffs two environments", () => {
    const left = createEnv("left", HOME);
    const right = createEnv("right", HOME);
    addSkillRecord(left.root, { name: "pdf", source: "local:/pdf" });
    installPlugin(right.root, "browser@openai-bundled");

    const summary = describeEnv(left.root, left.name);
    expect(summary.skills).toEqual(["pdf"]);
    expect(summary.plugins).toEqual([]);
    expect(summary.adapter).toBe("codex");

    const diff = diffEnvs(left.root, "left", right.root, "right");
    expect(diff.skillsOnlyLeft).toEqual(["pdf"]);
    expect(diff.skillsOnlyRight).toEqual([]);
    expect(diff.pluginsOnlyRight).toEqual(["browser@openai-bundled"]);
  });

  it("reads the adapter from the manifest", () => {
    const env = createEnv("adapted", HOME, "claude");
    expect(describeEnv(env.root, env.name).adapter).toBe("claude");
  });
});
