import path from "node:path";
import { statSync } from "node:fs";
import { addSkillRecord } from "./lock.js";
import {
  expandHome,
  githubSourceToLockSource,
  installGitHubSkill,
  installLocalSkill,
  parseGitHubSource,
  parseSourceSpec,
} from "./install.js";
import { listRegistrySkills, type RegistrySkill } from "./registry.js";
import { isNameSpec, resolveDependencies, type CatalogEntry, type Resolution } from "./resolve.js";

export interface InstalledSkill {
  name: string;
  source: string;
  version?: string;
  requiredBy: string[];
}

export interface InstallOutcome {
  installed: InstalledSkill[];
  warnings: string[];
}

export interface InstallOptions {
  /** Overwrite already-installed skills. */
  force?: boolean;
  /** Leave already-installed skills untouched (lock still reconciled). */
  skipExisting?: boolean;
}

/**
 * Install a mixed list of specs into an environment:
 * - `github:...` / `local:...` / filesystem paths install directly;
 * - bare names (optionally `name@range`) resolve against the registry with
 *   full dependency closure, then install in topological order.
 */
export async function installSpecs(
  envRoot: string,
  home: string,
  specs: string[],
  options: InstallOptions = {},
): Promise<InstallOutcome> {
  const force = options.force ?? false;
  const skipExisting = options.skipExisting ?? false;
  const nameSpecs = specs.filter(isNameSpec);
  const directSpecs = specs.filter((spec) => !isNameSpec(spec));

  const installed: InstalledSkill[] = [];
  const warnings: string[] = [];

  for (const spec of directSpecs) {
    const name = await installDirectSource(envRoot, spec, force);
    installed.push({ name, source: spec, requiredBy: ["manifest"] });
  }

  if (nameSpecs.length > 0) {
    const catalog = buildCatalog(home);
    const { resolved, warnings: resolveWarnings } = resolveDependencies(nameSpecs, catalog);
    warnings.push(...resolveWarnings);
    for (const resolution of resolved) {
      await installResolution(envRoot, resolution, { force, skipExisting });
      installed.push({
        name: resolution.name,
        source: resolution.source,
        version: resolution.version,
        requiredBy: resolution.requiredBy,
      });
    }
  }

  return { installed, warnings };
}

function buildCatalog(home: string): (name: string) => CatalogEntry | null {
  const byName = new Map<string, CatalogEntry>();
  for (const skill of listRegistrySkills(home)) {
    byName.set(skill.name, toCatalogEntry(skill));
  }
  return (name) => byName.get(name) ?? null;
}

export function toCatalogEntry(skill: RegistrySkill): CatalogEntry {
  const entry: CatalogEntry = { name: skill.name, versions: {} };
  if (skill.versions) {
    for (const [version, meta] of Object.entries(skill.versions)) {
      entry.versions[version] = { source: meta.source, dependencies: meta.dependencies };
    }
  } else if (skill.source) {
    entry.unversioned = { source: skill.source, dependencies: skill.dependencies };
  }
  return entry;
}

async function installDirectSource(envRoot: string, spec: string, force: boolean): Promise<string> {
  const source = parseSourceSpec(spec);
  if (source?.kind === "github") {
    return installGitHubSkill(envRoot, source, force);
  }
  if (source?.kind === "local") {
    return installLocalSkill(envRoot, source.dir, force);
  }
  // Not a path on disk and not a named source: treat as a local path so the
  // error message matches the direct-install contract.
  return installLocalSkill(envRoot, expandHome(spec), force);
}

async function installResolution(
  envRoot: string,
  resolution: Resolution,
  options: { force: boolean; skipExisting: boolean },
): Promise<void> {
  const name = resolution.name;
  const skillDir = path.join(envRoot, "skills", name);
  const alreadyInstalled =
    statSync(skillDir, { throwIfNoEntry: false })?.isDirectory() === true;

  // force → always reinstall; skipExisting → keep files; otherwise a present
  // install makes the underlying installer raise "skill already installed".
  const keepFiles = alreadyInstalled && options.skipExisting && !options.force;
  if (!keepFiles) {
    await installFromSource(envRoot, resolution.source, name, options.force);
  }

  // Registry-declared version and dependency edges win over SKILL.md frontmatter.
  addSkillRecord(envRoot, {
    name,
    source: lockSourceFor(resolution.source),
    version: resolution.version,
    dependencies: resolution.dependencies,
  });
}

async function installFromSource(envRoot: string, sourceSpec: string, expectedName: string, force: boolean): Promise<void> {
  const source = parseSourceSpec(sourceSpec);
  let installedName: string;
  if (source?.kind === "github") {
    installedName = await installGitHubSkill(envRoot, source, force);
  } else if (source?.kind === "local") {
    installedName = installLocalSkill(envRoot, source.dir, force);
  } else {
    try {
      installedName = await installGitHubSkill(envRoot, parseGitHubSource(sourceSpec), force);
    } catch {
      installedName = installLocalSkill(envRoot, expandHome(sourceSpec), force);
    }
  }
  if (installedName !== expectedName) {
    throw new Error(
      `registry source for '${expectedName}' installed a skill named '${installedName}'; the entry is inconsistent`,
    );
  }
}

function lockSourceFor(sourceSpec: string): string {
  const source = parseSourceSpec(sourceSpec);
  if (source?.kind === "github") {
    return githubSourceToLockSource(source);
  }
  if (source?.kind === "local") {
    return `local:${path.resolve(source.dir)}`;
  }
  try {
    return githubSourceToLockSource(parseGitHubSource(sourceSpec));
  } catch {
    return `local:${path.resolve(expandHome(sourceSpec))}`;
  }
}
