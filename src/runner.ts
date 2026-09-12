import { spawnSync } from "node:child_process";
import { buildAdapterEnv } from "./adapter.js";

/**
 * Environment variables for launching an agent inside an environment: the
 * adapter home variable plus generic SKILLENV_* markers, layered over the
 * parent environment (or an explicit base).
 */
export function buildRunEnv(
  envRoot: string,
  adapter: string,
  base: Record<string, string> = {},
): Record<string, string> {
  return { ...base, ...buildAdapterEnv(envRoot, adapter) };
}

/** Run a command with the adapter environment applied; inherits stdio. */
export function runCommand(envRoot: string, adapter: string, command: string[]): number {
  if (command.length === 0) {
    throw new Error("command cannot be empty");
  }
  const runEnv = buildRunEnv(envRoot, adapter, process.env as Record<string, string>);
  let result = spawnSync(command[0] as string, command.slice(1), {
    env: runEnv,
    stdio: "inherit",
  });
  // On Windows, npm-installed agent CLIs are .cmd shims that spawnSync
  // refuses to resolve directly; fall back to a shell resolution pass.
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === "ENOENT" &&
    process.platform === "win32"
  ) {
    result = spawnSync(command[0] as string, command.slice(1), {
      env: runEnv,
      stdio: "inherit",
      shell: true,
    });
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`command not found: ${command[0]}`);
    }
    throw result.error;
  }
  return result.status ?? 1;
}
