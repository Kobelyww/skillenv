import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Checkpoints: before the agent mutates a file, the original content is
 * snapshotted; /undo (or undoLast) restores the previous state step by step.
 * New files created by the agent are removed on undo. Manifest is JSONL.
 */

export interface CheckpointEntry {
  file: string;      // absolute path of the mutated file
  backup?: string;   // absolute path of the snapshot (absent for created files)
  created: boolean;  // the file did not exist before the agent wrote it
  tool: string;
  at: string;
}

export function checkpointPaths(envRoot: string, sessionId: string): { dir: string; log: string } {
  const dir = path.join(envRoot, "checkpoints", sessionId);
  return { dir, log: path.join(dir, "manifest.jsonl") };
}

/** Snapshot a file before mutation. No-op when the file does not exist. */
export function snapshotBefore(
  dir: string,
  log: string,
  file: string,
  tool: string,
): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existed = statSync(file, { throwIfNoEntry: false })?.isFile() === true;
  let backup: string | undefined;
  if (existed) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    backup = path.join(dir, `${stamp}-${Math.random().toString(36).slice(2, 6)}-${path.basename(file)}`);
    copyFileSync(file, backup);
  }
  const entry: CheckpointEntry = {
    file,
    ...(backup ? { backup } : {}),
    created: !existed,
    tool,
    at: new Date().toISOString(),
  };
  writeFileSync(log, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

/** Undo the most recent mutation in this session. Returns a description, or null when nothing to undo. */
export function undoLast(dir: string, log: string): string | null {
  if (!existsSync(log)) return null;
  const lines = readFileSync(log, "utf8").split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const last = JSON.parse(lines[lines.length - 1] as string) as CheckpointEntry;
  lines.pop();
  if (last.created) {
    if (existsSync(last.file)) unlinkSync(last.file);
  } else if (last.backup && existsSync(last.backup)) {
    copyFileSync(last.backup, last.file);
  }
  writeFileSync(log, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return last.created
    ? `removed created file ${last.file}`
    : `restored ${last.file} to its previous state`;
}
