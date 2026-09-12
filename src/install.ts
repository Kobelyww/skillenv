import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { addSkillRecord } from "./lock.js";
import { SKILL_FILE, readSkillMeta } from "./skill.js";

export interface LocalSkillSource {
  kind: "local";
  dir: string;
}

export interface GitHubSkillSource {
  kind: "github";
  owner: string;
  repo: string;
  /** Path inside the repository pointing at the skill directory. */
  path: string;
  ref: string;
}

export type SkillSource = LocalSkillSource | GitHubSkillSource;

export function parseGitHubSource(value: string): GitHubSkillSource {
  if (!value.startsWith("github:")) {
    throw new Error("GitHub skill source must start with github:");
  }
  const spec = value.slice("github:".length);
  const at = spec.indexOf("@");
  const pathPart = at === -1 ? spec : spec.slice(0, at);
  const ref = at === -1 ? "main" : spec.slice(at + 1);
  const pieces = pathPart.split("/").filter((piece) => piece.length > 0);
  if (pieces.length < 3) {
    throw new Error("GitHub skill source must be github:owner/repo/path");
  }
  if (ref.length === 0) {
    throw new Error("GitHub skill source ref cannot be empty");
  }
  // Path-traversal guard: no segment may escape the repository archive.
  for (const segment of [...pieces, ref]) {
    if (segment === "." || segment === "..") {
      throw new Error(`GitHub skill source cannot contain '.' or '..' path segments: ${value}`);
    }
  }
  const [owner, repo] = pieces;
  return { kind: "github", owner: owner as string, repo: repo as string, path: pieces.slice(2).join("/"), ref };
}

export function githubSourceToLockSource(source: GitHubSkillSource): string {
  return `github:${source.owner}/${source.repo}/${source.path}@${source.ref}`;
}

/**
 * Resolve a source spec into a concrete source. `github:...` and `local:...`
 * are explicit; anything else is a filesystem path when it exists and is left
 * for the caller (registry lookup) otherwise.
 */
export function parseSourceSpec(value: string): LocalSkillSource | GitHubSkillSource | null {
  if (value.startsWith("github:")) {
    return parseGitHubSource(value);
  }
  if (value.startsWith("local:")) {
    return { kind: "local", dir: expandHome(value.slice("local:".length)) };
  }
  const expanded = expandHome(value);
  if (existsSync(expanded)) {
    return { kind: "local", dir: expanded };
  }
  return null;
}

export function expandHome(value: string): string {
  return value.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
}

/** Install a local skill directory (must contain SKILL.md) into the environment. */
export function installLocalSkill(envRoot: string, sourceDir: string, force = false): string {
  const dir = path.resolve(expandHome(sourceDir));
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`skill directory not found: ${dir}`);
  }
  if (!existsSync(path.join(dir, SKILL_FILE))) {
    throw new Error(`not a skill directory, missing ${SKILL_FILE}: ${dir}`);
  }
  const destination = installDir(envRoot, dir, force);
  cpSync(dir, destination, { recursive: true });
  recordSkill(envRoot, path.basename(dir), `local:${dir}`);
  return path.basename(dir);
}

/** Install a skill from a GitHub repository subtree into the environment. */
export async function installGitHubSkill(
  envRoot: string,
  source: GitHubSkillSource,
  force = false,
  downloader: (source: GitHubSkillSource, destination: string) => Promise<void> = downloadGitHubSkill,
): Promise<string> {
  const name = path.posix.basename(source.path);
  const destination = path.join(envRoot, "skills", name);
  if (statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    if (!force) {
      throw new Error(`skill already installed: ${destination}`);
    }
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirSync(destination, { recursive: true });
  await downloader(source, destination);
  if (!existsSync(path.join(destination, SKILL_FILE))) {
    rmSync(destination, { recursive: true, force: true });
    throw new Error(`downloaded GitHub path is not a skill, missing ${SKILL_FILE}: ${source.path}`);
  }
  recordSkill(envRoot, name, githubSourceToLockSource(source));
  return name;
}

function installDir(envRoot: string, sourceDir: string, force: boolean): string {
  const destination = path.join(envRoot, "skills", path.basename(sourceDir));
  if (statSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    if (!force) {
      throw new Error(`skill already installed: ${destination}`);
    }
    rmSync(destination, { recursive: true, force: true });
  }
  return destination;
}

function recordSkill(envRoot: string, name: string, source: string): void {
  const meta = readSkillMeta(path.join(envRoot, "skills", name));
  addSkillRecord(envRoot, {
    name,
    source,
    version: meta.version,
    dependencies: meta.dependencies,
  });
}

/** Download a GitHub repository zipball and copy out the skill subtree. */
export async function downloadGitHubSkill(source: GitHubSkillSource, destination: string): Promise<void> {
  const url = `https://github.com/${source.owner}/${source.repo}/archive/${source.ref}.zip`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  const tempDir = mkdtempSync(path.join(tmpdir(), "skillenv-"));
  try {
    const archive = path.join(tempDir, "repo.zip");
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    const zip = new AdmZip(archive);
    const extractDir = path.join(tempDir, "repo");
    zip.extractAllTo(extractDir, true);
    const roots = readdirSafe(extractDir);
    if (roots.length !== 1) {
      throw new Error(`unexpected GitHub archive layout for ${url}`);
    }
    const sourceDir = path.join(extractDir, roots[0] as string, source.path);
    if (!statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`skill path not found in GitHub archive: ${source.path}`);
    }
    cpSync(sourceDir, destination, { recursive: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
