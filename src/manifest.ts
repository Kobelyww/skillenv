import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { readLock, type LockFile } from "./lock.js";

/** Parsed `skillenv.yml` manifest. Skill/plugin entries are raw spec strings. */
export interface Manifest {
  name: string;
  adapter: string;
  skills: string[];
  plugins: string[];
}

export const DEFAULT_ADAPTER = "codex";

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`manifest field '${field}' must be a list`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`manifest field '${field}' must contain only strings`);
    }
    return item;
  });
}

/** Parse manifest text. The legacy inline-list format is valid YAML flow syntax, so both eras load identically. */
export function parseManifest(text: string): Manifest {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw new Error(`manifest is not valid YAML: ${(error as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("manifest must be a YAML mapping");
  }
  const map = data as Record<string, unknown>;
  const name = map.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error("manifest is missing 'name'");
  }
  const adapter = map.adapter;
  return {
    name,
    adapter: typeof adapter === "string" && adapter.length > 0 ? adapter : DEFAULT_ADAPTER,
    skills: asStringArray(map.skills, "skills"),
    plugins: asStringArray(map.plugins, "plugins"),
  };
}

export function renderManifest(manifest: Manifest): string {
  return `${stringify(
    {
      name: manifest.name,
      adapter: manifest.adapter,
      skills: manifest.skills,
      plugins: manifest.plugins,
    },
    { lineWidth: 0 },
  )}`;
}

export function manifestPath(envRoot: string): string {
  return path.join(envRoot, "skillenv.yml");
}

export function readManifest(envRoot: string): Manifest {
  return parseManifest(readFileSync(manifestPath(envRoot), "utf8"));
}

export function writeManifest(envRoot: string, manifest: Manifest): void {
  writeFileSync(manifestPath(envRoot), renderManifest(manifest), "utf8");
}

/**
 * Export a reproducible manifest: when the lock file records installs, emit
 * their source specs; otherwise echo the manifest as-is.
 */
export function exportManifest(envRoot: string): string {
  const lock: LockFile = readLock(envRoot);
  if (lock.skills.length === 0 && lock.plugins.length === 0) {
    return readFileSync(manifestPath(envRoot), "utf8");
  }
  const manifest = readManifest(envRoot);
  return renderManifest({
    name: manifest.name,
    adapter: manifest.adapter,
    skills: lock.skills.map((skill) => skill.source),
    plugins: lock.plugins.map((plugin) =>
      typeof plugin.source === "string" ? plugin.source : plugin.name,
    ),
  });
}

export function loadManifestFile(file: string): Manifest {
  const resolved = file.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  if (!existsSync(resolved)) {
    throw new Error(`manifest file not found: ${file}`);
  }
  return parseManifest(readFileSync(resolved, "utf8"));
}
