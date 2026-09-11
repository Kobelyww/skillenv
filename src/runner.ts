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
  const result = spawnSync(command[0] as string, command.slice(1), {
    env: buildRunEnv(envRoot, adapter, process.env as Record<string, string>),
    stdio: "inherit",
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`command not found: ${command[0]}`);
    }
    throw result.error;
  }
  return result.status ?? 1;
}
