import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addPluginRecord, readLock } from "./lock.js";

/**
 * Record a plugin selector in the environment's `config.toml` as a
 * `[plugins."<selector>"]` block with `enabled = true`, mirroring the Codex
 * plugin config format.
 */
export function installPlugin(envRoot: string, selector: string): string {
  if (selector.trim().length === 0) {
    throw new Error("plugin selector cannot be empty");
  }
  const configFile = path.join(envRoot, "config.toml");
  const existing = existsSync(configFile) ? readFileSync(configFile, "utf8") : "";
  const blockHeader = `[plugins."${selector}"]`;
  if (!existing.includes(blockHeader)) {
    const separator = existing.endsWith("\n") ? "" : "\n\n";
    writeFileSync(configFile, `${existing}${separator}${blockHeader}\nenabled = true\n`, "utf8");
  }
  addPluginRecord(envRoot, selector, selector);
  return selector;
}

export function listPlugins(envRoot: string): string[] {
  return readLock(envRoot).plugins.map((plugin) => plugin.name);
}
