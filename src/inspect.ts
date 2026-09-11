import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAdapter } from "./adapter.js";
import { PROVIDERS } from "./agent/providers.js";
import { directoryChecksum, readLock } from "./lock.js";
import { listPlugins } from "./plugins.js";
import { SKILL_FILE } from "./skill.js";

export interface EnvSummary {
  name: string;
  root: string;
  adapter: string;
  skills: string[];
  plugins: string[];
}

export interface DoctorResult {
  ok: boolean;
  issues: string[];
}

export interface DiffResult {
  leftName: string;
  rightName: string;
  skillsOnlyLeft: string[];
  skillsOnlyRight: string[];
  pluginsOnlyLeft: string[];
  pluginsOnlyRight: string[];
}

export function describeEnv(envRoot: string, name: string): EnvSummary {
  const lock = readLock(envRoot);
  const adapter = readManifestAdapter(envRoot);
  return {
    name,
    root: envRoot,
    adapter,
    skills: lock.skills.map((skill) => skill.name),
    plugins: listPlugins(envRoot),
  };
}

function readManifestAdapter(envRoot: string): string {
  const manifestFile = path.join(envRoot, "skillenv.yml");
  try {
    const text = readFileSync(manifestFile, "utf8");
    const match = /^adapter:\s*(\S+)/m.exec(text);
    return match?.[1] ?? "codex";
  } catch {
    return "codex";
  }
}

/**
 * Health check: manifest/config presence, adapter-specific required files,
 * SKILL.md in every skill directory, and lock checksum verification.
 */
export interface ProviderReadiness {
  id: string;
  displayName: string;
  ready: boolean;
  missing: string;
}

/** Which agent providers have their credentials configured (never fatal). */
export function providerReadiness(): ProviderReadiness[] {
  return Object.values(PROVIDERS).map((preset) => {
    if (!preset.apiKeyEnv) {
      return { id: preset.id, displayName: preset.displayName, ready: true, missing: "" };
    }
    const hasKey = Boolean(process.env[preset.apiKeyEnv]);
    const needsBase = preset.baseUrlEnv ? Boolean(process.env[preset.baseUrlEnv]) : true;
    if (preset.baseUrlEnv && !preset.baseUrl && !needsBase) {
      return {
        id: preset.id,
        displayName: preset.displayName,
        ready: false,
        missing: `${preset.apiKeyEnv} and ${preset.baseUrlEnv}`,
      };
    }
    return {
      id: preset.id,
      displayName: preset.displayName,
      ready: hasKey,
      missing: hasKey ? "" : preset.apiKeyEnv,
    };
  });
}

export function checkEnv(envRoot: string, name: string): DoctorResult {
  const issues: string[] = [];
  const adapterId = readManifestAdapter(envRoot);

  let adapter;
  try {
    adapter = getAdapter(adapterId);
  } catch (error) {
    issues.push((error as Error).message);
    adapter = null;
  }

  const requiredFiles = ["skillenv.yml", ...(adapter ? adapter.requiredFiles : ["config.toml"])];
  for (const file of requiredFiles) {
    if (!existsSync(path.join(envRoot, file))) {
      issues.push(`missing ${file}`);
    }
  }

  const skillsDir = path.join(envRoot, "skills");
  if (!statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    issues.push("missing skills directory");
  } else {
    for (const entry of readdirSync(skillsDir).sort()) {
      const skillDir = path.join(skillsDir, entry);
      if (statSync(skillDir, { throwIfNoEntry: false })?.isDirectory() && !existsSync(path.join(skillDir, SKILL_FILE))) {
        issues.push(`missing ${SKILL_FILE}: skills/${entry}`);
      }
    }
  }

  const lock = readLock(envRoot);
  for (const skill of lock.skills) {
    if (!skill.checksum) continue;
    const skillDir = path.join(envRoot, "skills", skill.name);
    if (statSync(skillDir, { throwIfNoEntry: false })?.isDirectory() && directoryChecksum(skillDir) !== skill.checksum) {
      issues.push(`checksum mismatch: skills/${skill.name}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function diffEnvs(leftRoot: string, leftName: string, rightRoot: string, rightName: string): DiffResult {
  const left = describeEnv(leftRoot, leftName);
  const right = describeEnv(rightRoot, rightName);
  const setDifference = (a: string[], b: string[]): string[] =>
    a.filter((item) => !b.includes(item)).sort();
  return {
    leftName,
    rightName,
    skillsOnlyLeft: setDifference(left.skills, right.skills),
    skillsOnlyRight: setDifference(right.skills, left.skills),
    pluginsOnlyLeft: setDifference(left.plugins, right.plugins),
    pluginsOnlyRight: setDifference(right.plugins, left.plugins),
  };
}
