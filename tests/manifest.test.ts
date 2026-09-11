import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exportManifest,
  loadManifestFile,
  parseManifest,
  readManifest,
  renderManifest,
  writeManifest,
} from "../src/manifest.js";
import { createEnv, getEnv } from "../src/env.js";
import { addSkillRecord, addPluginRecord } from "../src/lock.js";
import { defaultHome } from "../src/config.js";

const HOME = mkdtempSync(path.join(tmpdir(), "manifest-"));
process.env.SKILLENV_HOME = HOME;

describe("parseManifest", () => {
  it("parses block YAML", () => {
    const manifest = parseManifest("name: demo\nadapter: claude\nskills:\n  - pdf\n  - latex@^1\nplugins: []\n");
    expect(manifest.name).toBe("demo");
    expect(manifest.adapter).toBe("claude");
    expect(manifest.skills).toEqual(["pdf", "latex@^1"]);
    expect(manifest.plugins).toEqual([]);
  });

  it("parses the legacy inline-list format", () => {
    const manifest = parseManifest("name: legacy\nadapter: codex\nskills: [pdf, latex]\nplugins: []\n");
    expect(manifest.name).toBe("legacy");
    expect(manifest.skills).toEqual(["pdf", "latex"]);
  });

  it("defaults the adapter to codex", () => {
    expect(parseManifest("name: x\nskills: []\nplugins: []\n").adapter).toBe("codex");
  });

  it("rejects manifests without a name", () => {
    expect(() => parseManifest("skills: []\n")).toThrow("missing 'name'");
  });

  it("rejects non-list skill fields", () => {
    expect(() => parseManifest("name: x\nskills: pdf\n")).toThrow("must be a list");
  });
});

describe("renderManifest", () => {
  it("round-trips through parse", () => {
    const original = { name: "demo", adapter: "pi", skills: ["a@^1"], plugins: ["b@c"] };
    expect(parseManifest(renderManifest(original))).toEqual(original);
  });
});

describe("exportManifest", () => {
  it("echoes the manifest when the lock is empty", () => {
    const env = createEnv("echo-env", HOME);
    const raw = readManifest(env.root);
    expect(exportManifest(env.root)).toBe(renderManifest(raw));
  });

  it("emits lock sources when installs are recorded", () => {
    const env = createEnv("lock-env", HOME);
    addSkillRecord(env.root, { name: "pdf", source: "github:openai/skills/skills/.curated/pdf@main" });
    addPluginRecord(env.root, "latex@openai-bundled", "latex@openai-bundled");
    const text = exportManifest(env.root);
    const manifest = parseManifest(text);
    expect(manifest.skills).toEqual(["github:openai/skills/skills/.curated/pdf@main"]);
    expect(manifest.plugins).toEqual(["latex@openai-bundled"]);
    expect(manifest.name).toBe("lock-env");
  });
});

describe("loadManifestFile", () => {
  it("loads and expands ~ paths", () => {
    const file = path.join(HOME, "env.yml");
    writeFileSync(file, "name: from-file\nskills:\n  - pdf@^1\nplugins: []\n", "utf8");
    const manifest = loadManifestFile(file);
    expect(manifest.name).toBe("from-file");
    expect(manifest.skills).toEqual(["pdf@^1"]);
  });

  it("throws for missing files", () => {
    expect(() => loadManifestFile(path.join(HOME, "nope.yml"))).toThrow("not found");
  });
});

describe("writeManifest", () => {
  it("writes YAML that parses back", () => {
    const env = getEnv("echo-env", defaultHome());
    const manifest = { name: "echo-env", adapter: "gemini", skills: ["x"], plugins: [] };
    writeManifest(env.root, manifest);
    expect(readManifest(env.root)).toEqual(manifest);
  });
});
