import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { utcNow } from "../lock.js";

/**
 * Environment-to-environment message bus.
 *
 * Every environment owns a `mailbox/` directory; a message is one JSON file
 * addressed to that environment. Sending is a local file write into the
 * recipient's mailbox — same skillenv home by default, any absolute
 * environment root via `toRoot`, so harnesses on the same machine can talk
 * without a server.
 */

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  created_at: string;
  read: boolean;
}

export function mailboxDir(envRoot: string): string {
  return path.join(envRoot, "mailbox");
}

function messageFile(envRoot: string, id: string): string {
  return path.join(mailboxDir(envRoot), `${id}.json`);
}

/** Send a message into another environment's mailbox. Returns the message id. */
export function sendMail(options: {
  fromEnv: string;
  fromRoot: string;
  toEnv: string;
  toRoot: string;
  subject: string;
  body: string;
}): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  const id = `msg-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
  const message: MailMessage = {
    id,
    from: options.fromEnv,
    to: options.toEnv,
    subject: options.subject,
    body: options.body,
    created_at: utcNow(),
    read: false,
  };
  const dir = mailboxDir(options.toRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(message, null, 2)}\n`, "utf8");
  return id;
}

/** List messages in an environment's mailbox, newest first. */
export function listMail(envRoot: string, options: { unreadOnly?: boolean } = {}): MailMessage[] {
  const dir = mailboxDir(envRoot);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const messages: MailMessage[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as MailMessage;
      if (typeof parsed.id === "string" && typeof parsed.body === "string") {
        if (!options.unreadOnly || !parsed.read) messages.push(parsed);
      }
    } catch {
      // A corrupt message file is skipped, never fatal.
    }
  }
  return messages.sort((a, b) => b.id.localeCompare(a.id));
}

/** Mark one message read. Returns false when the id is unknown. */
export function markMailRead(envRoot: string, id: string): boolean {
  const file = messageFile(envRoot, id);
  if (!existsSync(file)) return false;
  const message = JSON.parse(readFileSync(file, "utf8")) as MailMessage;
  message.read = true;
  writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`, "utf8");
  return true;
}

/** Read one message, marking it read. */
export function readMail(envRoot: string, id: string): MailMessage | null {
  const file = messageFile(envRoot, id);
  if (!existsSync(file)) return null;
  const message = JSON.parse(readFileSync(file, "utf8")) as MailMessage;
  if (!message.read) {
    message.read = true;
    writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`, "utf8");
  }
  return message;
}

/** Delete one message (cleanup). Returns false when the id is unknown. */
export function deleteMail(envRoot: string, id: string): boolean {
  const file = messageFile(envRoot, id);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}
