import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEnv } from "../src/env.js";
import { sendMail } from "../src/agent/mailbox.js";
import { pruneMail } from "../src/agent/mailbox.js";
import { syncMailboxes } from "../src/mail-sync.js";

const HOME = mkdtempSync(path.join(tmpdir(), "mailsync-"));
const bareRemote = path.join(HOME, "remote.git");
execSync(`git init --quiet --bare "${bareRemote}"`);

function homeWithEnvs(envAName: string, envBName: string): { home: string; a: string; b: string } {
  const home = mkdtempSync(path.join(tmpdir(), "mailbus-"));
  const a = createEnv(envAName, home).root;
  const b = createEnv(envBName, home).root;
  return { home, a, b };
}

describe("pruneMail", () => {
  it("deletes old read messages and keeps recent/unread ones", () => {
    const env = createEnv("prune-env", HOME);
    // Old read message, recent read message, old unread message.
    const old = path.join(env.root, "mailbox", "msg-old-read.json");
    const recent = path.join(env.root, "mailbox", "msg-new-read.json");
    const oldUnread = path.join(env.root, "mailbox", "msg-old-unread.json");
    mkdirSync(path.dirname(old), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    writeFileSync(old, JSON.stringify({ id: "msg-old-read", from: "x", to: "prune-env", subject: "s", body: "b", created_at: oldDate, read: true }));
    writeFileSync(recent, JSON.stringify({ id: "msg-new-read", from: "x", to: "prune-env", subject: "s", body: "b", created_at: new Date().toISOString(), read: true }));
    writeFileSync(oldUnread, JSON.stringify({ id: "msg-old-unread", from: "x", to: "prune-env", subject: "s", body: "b", created_at: oldDate, read: false }));

    expect(pruneMail(env.root, { maxAgeDays: 30 })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(oldUnread)).toBe(true);

    expect(pruneMail(env.root, { maxAgeDays: 30, includeUnread: true })).toBe(1);
    expect(existsSync(oldUnread)).toBe(false);
  });

  it("returns 0 for an empty mailbox", () => {
    const env = createEnv("prune-empty", HOME);
    expect(pruneMail(env.root, { maxAgeDays: 0, includeUnread: true })).toBe(0);
  });
});

describe("syncMailboxes", () => {
  it("moves messages between two homes over a git remote, both directions", () => {
    const { home: homeA, a: aRoot } = homeWithEnvs("sync-a", "unused-a2");
    const { home: homeB, b: bRoot } = homeWithEnvs("sync-b", "unused-b2");

    // Machine A: worker sends a message into its own env-a mailbox via
    // sendMail (as agent_send would), then syncs.
    sendMail({ fromEnv: "sync-a", fromRoot: aRoot, toEnv: "sync-b", toRoot: aRoot, subject: "handoff", body: "result: ok" });

    const outA = syncMailboxes(homeA, bareRemote, { message: "A export" });
    expect(outA.exported).toBe(1);
    expect(outA.commits).toBe(1);

    // Machine B: first sync imports A's message.
    const outB1 = syncMailboxes(homeB, bareRemote, { message: "B pull" });
    expect(outB1.imported).toBe(1);
    const imported = readdirSync(path.join(homeB, "envs", "sync-b", "mailbox"));
    expect(imported).toHaveLength(1);

    // Machine B replies and syncs.
    sendMail({ fromEnv: "sync-b", fromRoot: bRoot, toEnv: "sync-a", toRoot: bRoot, subject: "Re: handoff", body: "ack", type: "receipt" });
    const outB2 = syncMailboxes(homeB, bareRemote, { message: "B export" });
    expect(outB2.exported).toBe(1);

    // Machine A syncs again and receives the receipt.
    const outA2 = syncMailboxes(homeA, bareRemote, { message: "A pull" });
    expect(outA2.imported).toBe(1);
    const receipt = readFileSync(path.join(aRoot, "mailbox", readdirSync(path.join(aRoot, "mailbox"))[0] as string), "utf8");
    expect(receipt).toContain('"type": "receipt"');

    // Idempotent: syncing with nothing new exports nothing.
    const outA3 = syncMailboxes(homeA, bareRemote);
    expect(outA3.exported).toBe(0);
    expect(outA3.commits).toBe(0);
  });
});

describe("mailbox directory", () => {
  it("exists after createEnv", () => {
    const env = createEnv("mailbox-dir-check", HOME);
    expect(existsSync(path.join(env.root, "mailbox"))).toBe(true);
  });
});

afterAll(() => {
  void HOME;
});
