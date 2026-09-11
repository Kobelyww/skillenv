import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** A single installed skill as recorded in the lock file. */
export interface LockSkill {
  name: string;
  source: string;
  installed_at: string;
  /** Resolved semantic version, when the origin declared one. */
  version?: string;
  /** Dependency edges this skill pulled in, as `name@range` specs. */
  dependencies?: string[];
  /** `sha256:` digest of every file under the installed skill directory. */
  checksum?: string;
}

export interface LockPlugin {
  name: string;
  source: string;
  installed_at: string;
}

export interface LockFile {
  version: 1 | 2;
  skills: LockSkill[];
  plugins: LockPlugin[];
}

export function defaultLock(): LockFile {
  return { version: 2, skills: [], plugins: [] };
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * Stable checksum of a directory tree: sha256 over sorted relative paths and
 * file contents. Identical layout and bytes produce identical digests, so the
 * same skill installed twice anywhere yields the same checksum.
 */
export function directoryChecksum(root: string): string {
  const hash = createHash("sha256");
  for (const relative of sortedFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sortedFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(root);
  return files;
}

export function readLock(envRoot: string): LockFile {
  const file = path.join(envRoot, "lock.json");
  const lock = defaultLock();
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<LockFile>;
    if (typeof data.version === "number") {
      lock.version = data.version === 2 ? 2 : 1;
    }
    if (Array.isArray(data.skills)) {
      lock.skills = data.skills.filter(
        (skill): skill is LockSkill =>
          typeof skill?.name === "string" && typeof skill?.source === "string",
      );
    }
    if (Array.isArray(data.plugins)) {
      lock.plugins = data.plugins.filter(
        (plugin): plugin is LockPlugin =>
          typeof plugin?.name === "string" && typeof plugin?.source === "string",
      );
    }
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return lock;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`lock file is not valid JSON: ${file}`, { cause: error });
    }
    throw error;
  }
}

export function writeLock(envRoot: string, lock: LockFile): void {
  const normalized: LockFile = {
    version: lock.version === 2 ? 2 : 1,
    skills: [...lock.skills].sort((a, b) => a.name.localeCompare(b.name)),
    plugins: [...lock.plugins].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const file = path.join(envRoot, "lock.json");
  writeFileSyncIfChanged(file, `${JSON.stringify(normalized, null, 2)}\n`);
}

function writeFileSyncIfChanged(file: string, content: string): void {
  let current: string | null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current !== content) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
}

/** Insert or replace the lock record for one skill, keeping the list sorted. */
export function addSkillRecord(
  envRoot: string,
  record: Omit<LockSkill, "installed_at" | "checksum"> & {
    installed_at?: string;
    checksum?: string;
  },
): LockSkill {
  const lock = readLock(envRoot);
  const skillDir = path.join(envRoot, "skills", record.name);
  const full: LockSkill = {
    name: record.name,
    source: record.source,
    installed_at: record.installed_at ?? utcNow(),
  };
  if (record.version !== undefined) full.version = record.version;
  if (record.dependencies !== undefined && record.dependencies.length > 0) {
    full.dependencies = [...record.dependencies];
  }
  if (statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    full.checksum = directoryChecksum(skillDir);
  } else if (record.checksum !== undefined) {
    full.checksum = record.checksum;
  }
  lock.skills = [...lock.skills.filter((skill) => skill.name !== record.name), full];
  writeLock(envRoot, lock);
  return full;
}

/** Insert or replace the lock record for one plugin, keeping the list sorted. */
export function addPluginRecord(envRoot: string, name: string, source: string): void {
  const lock = readLock(envRoot);
  lock.plugins = [
    ...lock.plugins.filter((plugin) => plugin.name !== name),
    { name, source, installed_at: utcNow() },
  ];
  writeLock(envRoot, lock);
}
