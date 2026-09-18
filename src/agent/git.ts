import { spawnSync } from "node:child_process";

/** Git integration used by the agent REPL (/commit). Never pushes. */

export function isGitRepo(dir: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" });
  return result.status === 0 && result.stdout?.trim() === "true";
}

export function pendingChanges(dir: string): string {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", maxBuffer: 4_000_000 });
  return status.stdout ?? "";
}

export function commitAll(dir: string, message: string): { ok: boolean; output: string } {
  if (message.trim().length === 0) return { ok: false, output: "commit message is required" };
  const add = spawnSync("git", ["add", "-A"], { cwd: dir, encoding: "utf8" });
  if (add.status !== 0) return { ok: false, output: `git add failed: ${add.stderr ?? ""}` };
  const commit = spawnSync("git", ["commit", "-m", message.trim()], { cwd: dir, encoding: "utf8", maxBuffer: 4_000_000 });
  const output = `${commit.stdout ?? ""}${commit.stderr ?? ""}`.trim();
  return { ok: commit.status === 0, output: output.slice(0, 2000) };
}
