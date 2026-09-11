import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { envsDir } from "./config.js";

export interface Env {
  name: string;
  root: string;
}

/** Directories every environment starts with. */
export const ENV_SUBDIRS = ["skills", "plugins", "sessions", "log"] as const;

export function validateEnvName(name: string): string {
  if (name.length === 0) {
    throw new Error("environment name cannot be empty");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error("environment name cannot contain path separators");
  }
  if (name === "." || name === "..") {
    throw new Error(`environment name cannot be '${name}'`);
  }
  return name;
}

export function envPath(name: string, home: string): string {
  return path.join(envsDir(home), validateEnvName(name));
}

export function getEnv(name: string, home: string): Env {
  const root = envPath(name, home);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`environment not found: ${name}`);
  }
  return { name, root };
}

export function listEnvs(home: string): Env[] {
  const base = envsDir(home);
  if (!statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
    return [];
  }
  return readdirSync(base)
    .sort()
    .filter((entry) => statSync(path.join(base, entry), { throwIfNoEntry: false })?.isDirectory())
    .map((name) => ({ name, root: path.join(base, name) }));
}

/**
 * Create an environment directory with the standard layout:
 * `skills/`, `plugins/`, `sessions/`, `log/`, plus `config.toml` and
 * `skillenv.yml` placeholders when missing.
 */
export function createEnv(name: string, home: string, adapter = "codex"): Env {
  const root = envPath(name, home);
  mkdirSync(root, { recursive: true });
  for (const dir of ENV_SUBDIRS) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  const configFile = path.join(root, "config.toml");
  if (!existsSync(configFile)) {
    writeFileSync(configFile, `# skillenv managed ${adapter} home\n`, "utf8");
  }

  const manifestFile = path.join(root, "skillenv.yml");
  if (!existsSync(manifestFile)) {
    writeFileSync(manifestFile, renderDefaultManifest(name, adapter), "utf8");
  }

  return { name, root };
}

function renderDefaultManifest(name: string, adapter: string): string {
  return `name: ${name}\nadapter: ${adapter}\nskills: []\nplugins: []\n`;
}

/**
 * Clone an environment without sessions or logs: skills and plugins
 * directories, config.toml, lock.json, and a manifest with the name rewritten.
 */
export function cloneEnv(sourceName: string, targetName: string, home: string): Env {
  const source = getEnv(sourceName, home);
  const targetRoot = envPath(targetName, home);
  if (statSync(targetRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`environment already exists: ${targetName}`);
  }

  const target = createEnv(targetName, home);
  for (const dir of ["skills", "plugins"] as const) {
    rmSync(path.join(target.root, dir), { recursive: true, force: true });
    cpSync(path.join(source.root, dir), path.join(target.root, dir), { recursive: true });
  }

  for (const file of ["config.toml", "lock.json"] as const) {
    const sourceFile = path.join(source.root, file);
    if (existsSync(sourceFile)) {
      cpSync(sourceFile, path.join(target.root, file));
    }
  }

  const sourceManifest = path.join(source.root, "skillenv.yml");
  if (existsSync(sourceManifest)) {
    const text = readFileSync(sourceManifest, "utf8");
    writeFileSync(path.join(target.root, "skillenv.yml"), rewriteManifestName(text, targetName), "utf8");
  }

  return target;
}

/** Rewrite the `name:` line of a manifest, preserving every other line. */
export function rewriteManifestName(text: string, targetName: string): string {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.startsWith("name:")) {
      lines[index] = `name: ${targetName}`;
      return lines.join("\n");
    }
  }
  return `name: ${targetName}\n${text}`;
}

export function removeEnv(name: string, home: string): void {
  const root = envPath(name, home);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`environment not found: ${name}`);
  }
  rmSync(root, { recursive: true, force: true });
}
