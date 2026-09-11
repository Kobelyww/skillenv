import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registryCacheDir, registriesPath } from "./config.js";

/** A single versioned release of a registry skill. */
export interface RegistryVersion {
  source: string;
  dependencies?: string[];
}

/** A registry entry. Version 2 carries `versions`; version 1 carried a bare `source`. */
export interface RegistrySkill {
  name: string;
  description: string;
  source?: string;
  versions?: Record<string, RegistryVersion>;
  dependencies?: string[];
}

export interface RegistryPayload {
  version: 1 | 2;
  skills: RegistrySkill[];
}

export interface RegistrySource {
  name: string;
  url: string;
}

/** Bundled registry ships inside the npm package at `<pkg-root>/registry/skills.json`. */
export function bundledRegistryPath(): string {
  return fileURLToPath(new URL("../registry/skills.json", import.meta.url));
}

export function loadBundledRegistry(): RegistryPayload {
  return parseRegistryPayload(readFileSync(bundledRegistryPath(), "utf8"));
}

export function parseRegistryPayload(text: string): RegistryPayload {
  const data = JSON.parse(text) as Partial<RegistryPayload>;
  if (!Array.isArray(data.skills)) {
    throw new Error("registry payload must contain a 'skills' array");
  }
  return {
    version: data.version === 2 ? 2 : 1,
    skills: data.skills
      .filter((skill): skill is RegistrySkill => typeof skill?.name === "string")
      .map(normalizeRegistrySkill),
  };
}

function normalizeRegistrySkill(skill: RegistrySkill): RegistrySkill {
  const normalized: RegistrySkill = { name: skill.name, description: skill.description ?? "" };
  if (typeof skill.source === "string") normalized.source = skill.source;
  if (skill.dependencies) {
    normalized.dependencies = skill.dependencies.filter((dep): dep is string => typeof dep === "string");
  }
  if (skill.versions && typeof skill.versions === "object") {
    const versions: Record<string, RegistryVersion> = {};
    for (const [version, entry] of Object.entries(skill.versions)) {
      if (entry && typeof entry.source === "string") {
        versions[version] = {
          source: entry.source,
          ...(entry.dependencies ? { dependencies: entry.dependencies.filter((d): d is string => typeof d === "string") } : {}),
        };
      }
    }
    if (Object.keys(versions).length > 0) normalized.versions = versions;
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/* User registry sources                                              */
/* ------------------------------------------------------------------ */

export function listRegistrySources(home: string): RegistrySource[] {
  const file = registriesPath(home);
  if (!existsSync(file)) {
    return [];
  }
  const data = JSON.parse(readFileSync(file, "utf8")) as { registries?: RegistrySource[] };
  return Array.isArray(data.registries) ? data.registries : [];
}

export function addRegistrySource(name: string, url: string, home: string): void {
  const file = registriesPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const sources = [...listRegistrySources(home).filter((source) => source.name !== name), { name, url }].sort(
    (a, b) => a.name.localeCompare(b.name),
  );
  writeFileSync(file, `${JSON.stringify({ version: 1, registries: sources }, null, 2)}\n`, "utf8");
}

/** Fetch every configured source (file path or URL) into the registry cache. */
export async function updateRegistryCache(home: string): Promise<number> {
  const cache = registryCacheDir(home);
  mkdirSync(cache, { recursive: true });
  let updated = 0;
  for (const source of listRegistrySources(home)) {
    const payload = await fetchRegistryPayload(source.url);
    writeFileSync(path.join(cache, `${source.name}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    updated += 1;
  }
  return updated;
}

async function fetchRegistryPayload(url: string): Promise<RegistryPayload> {
  const asPath = expandUserPath(url);
  if (existsSync(asPath)) {
    return parseRegistryPayload(readFileSync(asPath, "utf8"));
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to fetch registry ${url}: HTTP ${response.status}`);
  }
  return parseRegistryPayload(await response.text());
}

function expandUserPath(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
}

/* ------------------------------------------------------------------ */
/* Merged catalog                                                     */
/* ------------------------------------------------------------------ */

/** Bundled registry first, then cached payloads sorted by filename; later entries win on name conflicts. */
export function iterRegistryPayloads(home: string): RegistryPayload[] {
  const payloads = [loadBundledRegistry()];
  const cache = registryCacheDir(home);
  if (statSync(cache, { throwIfNoEntry: false })?.isDirectory()) {
    for (const file of readdirSync(cache).sort()) {
      if (file.endsWith(".json")) {
        try {
          payloads.push(parseRegistryPayload(readFileSync(path.join(cache, file), "utf8")));
        } catch {
          // A corrupt cache entry must not break listing; it is refreshed by `registry update`.
        }
      }
    }
  }
  return payloads;
}

/** All registry skills across bundled + cached payloads, deduplicated by name (later wins). */
export function listRegistrySkills(home: string): RegistrySkill[] {
  const byName = new Map<string, RegistrySkill>();
  for (const payload of iterRegistryPayloads(home)) {
    for (const skill of payload.skills) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function searchRegistrySkills(query: string, home: string): RegistrySkill[] {
  const needle = query.toLowerCase();
  return listRegistrySkills(home).filter((skill) => {
    const haystack = [skill.name, skill.description, skill.source ?? "", Object.keys(skill.versions ?? {}).join(" ")]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function getRegistrySkill(name: string, home: string): RegistrySkill {
  const skill = listRegistrySkills(home).find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`registry skill not found: ${name}`);
  }
  return skill;
}
