import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPlugin, listPlugins } from "../src/plugins.js";
import { createEnv } from "../src/env.js";
import { readLock } from "../src/lock.js";

const HOME = mkdtempSync(path.join(tmpdir(), "plugins-"));

describe("installPlugin", () => {
  it("appends a config.toml block and records the selector", () => {
    const env = createEnv("plug", HOME);
    installPlugin(env.root, "latex@openai-bundled");
    installPlugin(env.root, "browser@openai-bundled");

    const config = readFileSync(path.join(env.root, "config.toml"), "utf8");
    expect(config).toContain('[plugins."latex@openai-bundled"]');
    expect(config).toContain("enabled = true");
    expect(config).toContain('[plugins."browser@openai-bundled"]');

    expect(listPlugins(env.root)).toEqual(["browser@openai-bundled", "latex@openai-bundled"]);
    expect(readLock(env.root).plugins.map((p) => p.name)).toEqual([
      "browser@openai-bundled",
      "latex@openai-bundled",
    ]);
  });

  it("is idempotent per selector", () => {
    const env = createEnv("plug2", HOME);
    installPlugin(env.root, "same@sel");
    const afterFirst = readFileSync(path.join(env.root, "config.toml"), "utf8");
    installPlugin(env.root, "same@sel");
    expect(readFileSync(path.join(env.root, "config.toml"), "utf8")).toBe(afterFirst);
    expect(readLock(env.root).plugins).toHaveLength(1);
  });

  it("rejects empty selectors", () => {
    const env = createEnv("plug3", HOME);
    expect(() => installPlugin(env.root, " ")).toThrow("cannot be empty");
  });
});
