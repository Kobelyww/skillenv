import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillMeta, SKILL_FILE } from "../src/skill.js";
import {
  createClaudeCodeAdapter,
  createCodexPluginAdapter,
  createGeminiAdapter,
  createPiAdapter,
} from "../src/scaffolds.js";
import { buildRunEnv, runCommand } from "../src/runner.js";
import { mkdirSync, writeFileSync } from "node:fs";

const HOME = mkdtempSync(path.join(tmpdir(), "gaps-"));

describe("readSkillMeta", () => {
  it("parses full frontmatter", () => {
    const dir = path.join(HOME, "meta-full");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, SKILL_FILE),
      "---\nname: x\ndescription: d\nversion: 1.0.0\ndependencies:\n  - a@^1\n  - \n  -   \n---\nbody",
      "utf8",
    );
    const meta = readSkillMeta(dir);
    expect(meta).toEqual({ name: "x", description: "d", version: "1.0.0", dependencies: ["a@^1"] });
  });

  it("returns empty meta for missing or malformed frontmatter", () => {
    const dir = path.join(HOME, "meta-none");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, SKILL_FILE), "no frontmatter here", "utf8");
    expect(readSkillMeta(dir)).toEqual({});

    const dirNoFile = path.join(HOME, "meta-nofile");
    mkdirSync(dirNoFile, { recursive: true });
    expect(existsSync(path.join(dirNoFile, SKILL_FILE))).toBe(false);

    const dir2 = path.join(HOME, "meta-bad");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path.join(dir2, SKILL_FILE), "---\n: [broken\n---\n", "utf8");
    expect(readSkillMeta(dir2)).toEqual({});

    expect(readSkillMeta(path.join(HOME, "missing-dir"))).toEqual({});
  });

  it("isSkillDir detects SKILL.md presence", async () => {
    const { isSkillDir } = await import("../src/skill.js");
    expect(isSkillDir(path.join(HOME, "meta-full"))).toBe(true);
    expect(isSkillDir(path.join(HOME, "meta-nofile"))).toBe(false);
    expect(isSkillDir(path.join(HOME, "missing-dir"))).toBe(false);
  });
});

describe("adapter scaffolds", () => {
  it("creates complete artifacts for all four agents", () => {
    const out = mkdtempSync(path.join(tmpdir(), "scaffolds-"));
    const codex = createCodexPluginAdapter(out);
    expect(existsSync(path.join(codex, ".codex-plugin", "plugin.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(codex, ".codex-plugin", "plugin.json"), "utf8")).name).toBe("skillenv-codex");
    expect(existsSync(path.join(codex, "skills", "skillenv", "SKILL.md"))).toBe(true);

    const claude = createClaudeCodeAdapter(out);
    expect(existsSync(path.join(claude, ".claude", "skills", "skillenv", "SKILL.md"))).toBe(true);

    const pi = createPiAdapter(out);
    expect(existsSync(path.join(pi, "skills", "skillenv", "SKILL.md"))).toBe(true);

    const gemini = createGeminiAdapter(out);
    expect(existsSync(path.join(gemini, "skills", "skillenv", "SKILL.md"))).toBe(true);

    const claudeSkill = readFileSync(path.join(claude, ".claude", "skills", "skillenv", "SKILL.md"), "utf8");
    expect(claudeSkill).toContain("CLAUDE_CONFIG_DIR");
  });
});

describe("runner", () => {
  it("runs commands with the adapter environment", () => {
    const envRoot = mkdtempSync(path.join(tmpdir(), "runner-"));
    const runEnv = buildRunEnv(envRoot, "codex", { BASE: "yes" });
    expect(runEnv.CODEX_HOME).toBe(envRoot);
    expect(runEnv.BASE).toBe("yes");

    const code = runCommand(envRoot, "codex", [
      "node",
      "-e",
      "process.exit(process.env.CODEX_HOME === undefined ? 1 : 0)",
    ]);
    expect(code).toBe(0);
  });

  it("reports missing commands clearly", () => {
    const envRoot = mkdtempSync(path.join(tmpdir(), "runner-missing-"));
    expect(() => runCommand(envRoot, "codex", ["definitely-missing-binary-xyz"])).toThrow(
      "command not found",
    );
  });

  it("rejects empty commands", () => {
    const envRoot = mkdtempSync(path.join(tmpdir(), "runner-empty-"));
    expect(() => runCommand(envRoot, "codex", [])).toThrow("cannot be empty");
  });
});
