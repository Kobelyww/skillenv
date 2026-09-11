import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { utcNow, type LockFile } from "../lock.js";
import type { ChatMessage } from "./providers.js";

export interface AgentSession {
  id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  model: string;
  env: string;
  messages: ChatMessage[];
}

export function sessionDir(envRoot: string): string {
  return path.join(envRoot, "sessions");
}

export function createSession(envRoot: string, env: string, provider: string, model: string): AgentSession {
  const now = utcNow();
  return {
    id: `agent-${now.replace(/[-:]/g, "").replace("Z", "")}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: now,
    updated_at: now,
    provider,
    model,
    env,
    messages: [],
  };
}

export function saveSession(envRoot: string, session: AgentSession): string {
  const dir = sessionDir(envRoot);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session.id}.json`);
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return file;
}

export function loadSession(envRoot: string, id: string): AgentSession {
  const file = path.join(sessionDir(envRoot), `${id}.json`);
  if (!existsSync(file)) {
    throw new Error(`session not found: ${id}`);
  }
  const data = JSON.parse(readFileSync(file, "utf8")) as AgentSession;
  if (!Array.isArray(data.messages)) {
    throw new Error(`session file is corrupted: ${file}`);
  }
  return data;
}

export function listSessions(envRoot: string): AgentSession[] {
  const dir = sessionDir(envRoot);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as AgentSession;
      } catch {
        return null;
      }
    })
    .filter((session): session is AgentSession => session !== null);
}

/** Lock metadata snapshot stored alongside sessions for provenance. */
export function lockSnapshot(lock: LockFile): Pick<LockFile, "version" | "skills"> {
  return { version: lock.version, skills: lock.skills };
}
