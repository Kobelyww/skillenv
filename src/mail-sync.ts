import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mailboxDir } from "./agent/mailbox.js";

/**
 * Cross-machine mailbox sync over a plain git remote.
 *
 * Each skillenv home gets a "mailbus" working directory (a git checkout of
 * `<remote>/<env-name>/msg-*.json`). Sync = pull → import new peer messages
 * into local mailboxes → export new local messages into the workdir →
 * commit → push. Message files are unique per message, so concurrent syncs
 * from different machines merge without conflicts.
 */

export interface MailSyncOutcome {
  imported: number;
  exported: number;
  commits: number;
  workdir: string;
}

function runGit(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFailure) return "";
    const detail = (error as Error).message.split("\n").slice(-3).join("\n");
    throw new Error(`git ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

function mailBusDir(home: string): string {
  return path.join(home, "mailbus");
}

function localEnvs(home: string): { name: string; root: string }[] {
  const envsDir = path.join(home, "envs");
  if (!statSync(envsDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(envsDir)
    .filter((entry) => statSync(path.join(envsDir, entry), { throwIfNoEntry: false })?.isDirectory())
    .map((name) => ({ name, root: path.join(envsDir, name) }));
}

/**
 * Synchronize every local environment's mailbox with a git remote.
 * `remote` may be any git URL or an existing local path (bare or working
 * tree). The mailbus checkout lives under `<home>/mailbus`.
 */
export function syncMailboxes(home: string, remote: string, options: { message?: string } = {}): MailSyncOutcome {
  const bus = mailBusDir(home);
  mkdirSync(bus, { recursive: true });

  if (!existsSync(path.join(bus, ".git"))) {
    // Fresh checkout: clone when the remote has history, otherwise init and
    // set the remote so the first push establishes the branch.
    try {
      execFileSync("git", ["clone", "--quiet", remote, bus], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      runGit(home, ["init", "--quiet", bus]);
      runGit(bus, ["remote", "add", "origin", remote]);
    }
  } else {
    runGit(bus, ["remote", "set-url", "origin", remote]);
  }

  // Pull is best-effort: an empty remote has no branch to pull yet.
  runGit(bus, ["pull", "--quiet", "--no-rebase", "origin"], true);

  let imported = 0;
  let exported = 0;

  const envNames = new Set(localEnvs(home).map((env) => env.name));
  const envRoots = new Map(localEnvs(home).map((env) => [env.name, env.root]));

  // Import: bus/<my-env-name>/ holds messages addressed to local envs that
  // this machine has not received yet.
  for (const env of localEnvs(home)) {
    const busEnvDir = path.join(bus, env.name);
    if (!statSync(busEnvDir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const localMail = mailboxDir(env.root);
    mkdirSync(localMail, { recursive: true });
    for (const file of readdirSync(busEnvDir)) {
      if (!file.endsWith(".json")) continue;
      const target = path.join(localMail, file);
      if (existsSync(target)) continue;
      writeFileSync(target, readFileSync(path.join(busEnvDir, file), "utf8"));
      imported += 1;
    }
  }

  // Export: for every local env, messages whose *recipient* is another env
  // go to bus/<recipient>/; messages addressed to this env (received mail)
  // stay local. Each message is exported exactly once (synced flag).
  for (const env of localEnvs(home)) {
    const dir = mailboxDir(env.root);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const to = typeof message.to === "string" ? message.to : "";
      if (to === env.name || to.length === 0) continue; // received mail stays local
      if (message.synced === true) continue; // already on the bus
      const busEnvDir = path.join(bus, to);
      mkdirSync(busEnvDir, { recursive: true });
      const target = path.join(busEnvDir, file);
      if (existsSync(target)) {
        // Already delivered by another machine; just mark it locally.
        message.synced = true;
        writeFileSync(path.join(dir, file), `${JSON.stringify(message, null, 2)}\n`, "utf8");
        continue;
      }
      writeFileSync(target, readFileSync(path.join(dir, file), "utf8"));
      message.synced = true;
      writeFileSync(path.join(dir, file), `${JSON.stringify(message, null, 2)}\n`, "utf8");
      exported += 1;
    }
  }
  void envNames;
  void envRoots;

  let commits = 0;
  const pending = runGit(bus, ["status", "--porcelain"]);
  if (pending.trim().length > 0) {
    runGit(bus, ["add", "-A"]);
    runGit(bus, ["-c", "user.name=skillenv", "-c", "user.email=skillenv@local", "commit", "--quiet", "-m", options.message ?? "skillenv mail sync"]);
    commits = 1;
    runGit(bus, ["push", "--quiet", "-u", "origin", "HEAD"]);
  }

  return { imported, exported, commits, workdir: bus };
}
