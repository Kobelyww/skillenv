import { homedir } from "node:os";
import path from "node:path";

/**
 * Resolve the skillenv home directory.
 *
 * Precedence: `SKILLENV_HOME` environment variable, then `~/.skillenv`.
 * Read on every call so tests and nested invocations can redirect the home.
 */
export function defaultHome(): string {
  const configured = process.env.SKILLENV_HOME;
  if (configured && configured.trim().length > 0) {
    return path.resolve(configured.replace(/^~(?=\/|$)/, homedir()));
  }
  return path.join(homedir(), ".skillenv");
}

export function envsDir(home: string = defaultHome()): string {
  return path.join(home, "envs");
}

export function registriesPath(home: string = defaultHome()): string {
  return path.join(home, "registries.json");
}

export function registryCacheDir(home: string = defaultHome()): string {
  return path.join(home, "registry-cache");
}

export function sessionsDir(home: string = defaultHome()): string {
  return path.join(home, "sessions");
}
