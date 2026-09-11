import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { SKILL_FILE } from "./skill.js";

export interface PublishEntry {
  name: string;
  description: string;
  versions: Record<string, { source: string; dependencies?: string[] }>;
}

export interface PublishResult {
  entry: PublishEntry;
  warnings: string[];
}

export interface PublishOptions {
  /** Registry source spec recorded in the entry, e.g. github:owner/repo/path@v1.0.0. */
  source?: string;
  /** Existing registry JSON file to upsert into; prints to stdout when omitted. */
  registry?: string;
  dependencies?: string[];
}

/**
 * Validate a skill directory and produce (or upsert) a versioned registry
 * entry. The source spec defaults to `local:<abs-dir>`; pass --source for the
 * published location (e.g. the GitHub path users will install from).
 */
export function publishSkill(skillDir: string, options: PublishOptions = {}): PublishResult {
  const dir = path.resolve(skillDir.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
  if (!existsSync(dir) || !statDirIsDir(dir)) {
    throw new Error(`skill directory not found: ${dir}`);
  }
  const skillFile = path.join(dir, SKILL_FILE);
  if (!existsSync(skillFile)) {
    throw new Error(`not a skill directory, missing ${SKILL_FILE}: ${dir}`);
  }

  const text = readFileSync(skillFile, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!match) {
    throw new Error(`${SKILL_FILE} has no YAML frontmatter; publishable skills need name, description, and version`);
  }
  const meta = (parse(match[1] ?? "") ?? {}) as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  const version = typeof meta.version === "string" ? meta.version.trim() : "";
  const frontmatterDependencies = Array.isArray(meta.dependencies)
    ? meta.dependencies.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
    : [];
  const warnings: string[] = [];

  if (name.length === 0) throw new Error("frontmatter is missing 'name'");
  if (description.length === 0) throw new Error("frontmatter is missing 'description'");
  if (version.length === 0) {
    throw new Error("frontmatter is missing 'version'; registry entries are versioned");
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    throw new Error(`version '${version}' is not valid semver (expected X.Y.Z)`);
  }
  if (name !== path.basename(dir)) {
    warnings.push(`skill name '${name}' differs from directory name '${path.basename(dir)}'`);
  }
  if (!options.source) {
    warnings.push(`no --source given; entry records local:${dir} which is not reproducible for other users`);
  }

  const source = options.source ?? `local:${dir}`;
  // SKILL.md frontmatter dependencies are the default; --depends adds more.
  const dependencies = [
    ...frontmatterDependencies,
    ...(options.dependencies ?? []),
  ]
    .map((dep) => dep.trim())
    .filter((dep) => dep.length > 0)
    .filter((dep, index, all) => all.indexOf(dep) === index);

  const entry: PublishEntry = { name, description, versions: { [version]: { source } } };
  if (dependencies.length > 0) {
    entry.versions[version] = { source, dependencies };
  }

  if (options.registry) {
    upsertIntoRegistry(options.registry, entry);
  }
  return { entry, warnings };
}

function upsertIntoRegistry(registryFile: string, entry: PublishEntry): void {
  const file = path.resolve(registryFile.replace(/^~(?=\/|$)/, process.env.HOME ?? ""));
  const payload: { version: 1 | 2; skills: PublishEntry[] } = { version: 2, skills: [] };
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<typeof payload>;
    if (Array.isArray(parsed.skills)) {
      payload.skills = parsed.skills as PublishEntry[];
    }
    payload.version = parsed.version === 1 ? 1 : 2;
  }
  payload.skills = [
    ...payload.skills.filter((skill) => skill.name !== entry.name),
    entry,
  ].sort((a, b) => a.name.localeCompare(b.name));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function statDirIsDir(dir: string): boolean {
  return statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
}
