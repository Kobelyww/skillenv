import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { readSkillMeta, SKILL_FILE } from "../skill.js";
import { listMail, markMailRead, sendMail } from "./mailbox.js";

export interface ToolContext {
  /** Working directory for relative paths and shell commands. */
  workdir: string;
  /** Environment root (skills live in <envRoot>/skills). */
  envRoot: string;
  /** Environment display name (mailbox sender identity). */
  envName?: string;
  /** Shell command timeout in milliseconds. */
  commandTimeoutMs?: number;
  /**
   * Human-in-the-loop gate for `run_command`: resolve true to execute.
   * When absent, shell commands run without confirmation.
   */
  confirmShell?: (command: string) => Promise<boolean>;
  /** Peer harnesses available for agent_send/agent_inbox (name → env root). */
  peers?: { name: string; envRoot: string }[];
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolContext2 {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult> | ToolResult;
}

const MAX_OUTPUT = 16_000;

function truncate(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated ${text.length - limit} characters]`;
}

function resolveIn(context: ToolContext, requested: unknown, fallback = "."): string {
  const value = typeof requested === "string" && requested.length > 0 ? requested : fallback;
  return path.resolve(context.workdir, value);
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                               */
/* ------------------------------------------------------------------ */

const readFileTool: ToolContext2 = {
  name: "read_file",
  description:
    "Read a UTF-8 text file relative to the working directory. Supports optional 1-based line offset and line limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      offset: { type: "number", description: "1-based first line to read." },
      limit: { type: "number", description: "Maximum number of lines to read." },
    },
    required: ["path"],
  },
  execute: (args, context) => {
    const file = resolveIn(context, args.path);
    try {
      const text = readFileSync(file, "utf8");
      const offset = typeof args.offset === "number" ? Math.max(1, Math.floor(args.offset)) : 1;
      const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : 2000;
      const lines = text.split("\n");
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, index) => `${offset + index}\t${line}`).join("\n");
      return { ok: true, output: truncate(numbered) };
    } catch (error) {
      return { ok: false, output: `cannot read ${file}: ${(error as Error).message}` };
    }
  },
};

const writeFileTool: ToolContext2 = {
  name: "write_file",
  description: "Create or overwrite a file with the given content (UTF-8). Parent directories are created.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      content: { type: "string", description: "Full file content to write." },
    },
    required: ["path", "content"],
  },
  execute: (args, context) => {
    const file = resolveIn(context, args.path);
    if (typeof args.content !== "string") {
      return { ok: false, output: "content must be a string" };
    }
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, args.content, "utf8");
      return { ok: true, output: `wrote ${file} (${args.content.length} bytes)` };
    } catch (error) {
      return { ok: false, output: `cannot write ${file}: ${(error as Error).message}` };
    }
  },
};

const editFileTool: ToolContext2 = {
  name: "edit_file",
  description:
    "Replace an exact, unique substring inside a file. old_string must match exactly once; otherwise the edit is rejected.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the working directory." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_string", "new_string"],
  },
  execute: (args, context) => {
    const file = resolveIn(context, args.path);
    const oldString = args.old_string;
    const newString = args.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return { ok: false, output: "old_string and new_string must be strings" };
    }
    try {
      const text = readFileSync(file, "utf8");
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        return { ok: false, output: `old_string not found in ${file}` };
      }
      if (occurrences > 1) {
        return { ok: false, output: `old_string matches ${occurrences} times in ${file}; make it unique` };
      }
      // Function form: replacement strings containing $&, $1, … must be
      // inserted literally, not expanded as replace patterns.
      writeFileSync(file, text.replace(oldString, () => newString), "utf8");
      return { ok: true, output: `edited ${file}` };
    } catch (error) {
      return { ok: false, output: `cannot edit ${file}: ${(error as Error).message}` };
    }
  },
};

const listDirTool: ToolContext2 = {
  name: "list_dir",
  description: "List the entries of a directory relative to the working directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, relative to the working directory." },
    },
    required: [],
  },
  execute: (args, context) => {
    const dir = resolveIn(context, args.path);
    try {
      const entries = readdirSync(dir)
        .sort()
        .map((entry) => {
          const full = path.join(dir, entry);
          const isDir = statSync(full, { throwIfNoEntry: false })?.isDirectory();
          return isDir ? `${entry}/` : entry;
        });
      if (entries.length === 0) return { ok: true, output: "(empty directory)" };
      return { ok: true, output: truncate(entries.join("\n")) };
    } catch (error) {
      return { ok: false, output: `cannot list ${dir}: ${(error as Error).message}` };
    }
  },
};

const globTool: ToolContext2 = {
  name: "glob",
  description:
    "Find files by glob pattern (e.g. src/**/*.ts). Supported: *, **, ?, and [abc] classes. Returns up to 200 paths.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the working directory." },
    },
    required: ["pattern"],
  },
  execute: (args, context) => {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (pattern.length === 0) return { ok: false, output: "pattern is required" };
    try {
      const matches = globSearch(context.workdir, pattern, 200);
      if (matches.length === 0) return { ok: true, output: "(no matches)" };
      return { ok: true, output: truncate(matches.join("\n")) };
    } catch (error) {
      return { ok: false, output: `glob failed: ${(error as Error).message}` };
    }
  },
};

function globSearch(root: string, pattern: string, limit: number): string[] {
  const regex = globToRegex(pattern);
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (results.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = path.join(dir, entry);
      const relative = path.relative(root, full).split(path.sep).join("/");
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (regex.test(`${relative}/`)) results.push(`${relative}/`);
        walk(full);
      } else if (regex.test(relative)) {
        results.push(relative);
      }
      if (results.length >= limit) return;
    }
  };
  walk(root);
  return results;
}

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
        source += "(?:.*(?:/|$))?";
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[" ) {
      const end = pattern.indexOf("]", index);
      if (end === -1) {
        source += "\\[";
      } else {
        source += pattern.slice(index, end + 1);
        index = end;
      }
    } else {
      source += char.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const grepTool: ToolContext2 = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns file:line:text matches (up to 200).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (JS syntax)." },
      path: { type: "string", description: "Directory or file to search, relative to the working directory." },
      include: { type: "string", description: "Optional glob filter for file names, e.g. *.ts" },
    },
    required: ["pattern"],
  },
  execute: (args, context) => {
    const raw = typeof args.pattern === "string" ? args.pattern : "";
    if (raw.length === 0) return { ok: false, output: "pattern is required" };
    let regex: RegExp;
    try {
      regex = new RegExp(raw);
    } catch (error) {
      return { ok: false, output: `invalid regex: ${(error as Error).message}` };
    }
    const includeRegex = typeof args.include === "string" && args.include.length > 0 ? globToRegex(args.include) : null;
    const base = resolveIn(context, args.path);
    const targetStat = statSync(base, { throwIfNoEntry: false });
    if (!targetStat) return { ok: false, output: `path not found: ${base}` };

    const matches: string[] = [];
    const searchFile = (file: string): void => {
      if (matches.length >= 200) return;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return;
      }
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (regex.test(lines[index] ?? "")) {
          matches.push(`${file}:${index + 1}:${(lines[index] ?? "").trim().slice(0, 240)}`);
          if (matches.length >= 200) return;
        }
      }
    };
    const walk = (dir: string): void => {
      if (matches.length >= 200) return;
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".git") continue;
        const full = path.join(dir, entry);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isDirectory()) walk(full);
        else if (!includeRegex || includeRegex.test(entry)) searchFile(full);
        if (matches.length >= 200) return;
      }
    };
    if (targetStat.isFile()) {
      searchFile(base);
    } else {
      walk(base);
    }
    if (matches.length === 0) return { ok: true, output: "(no matches)" };
    return { ok: true, output: truncate(matches.join("\n")) };
  },
};

const runCommandTool: ToolContext2 = {
  name: "run_command",
  description:
    "Run a shell command (sh -c on POSIX) in the working directory and capture stdout+stderr. Timed out or non-zero exits are reported, not fatal.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command line to execute." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 60000, max 300000)." },
      cwd: { type: "string", description: "Optional working directory override, relative to the working directory." },
    },
    required: ["command"],
  },
  execute: async (args, context) => {
    const command = typeof args.command === "string" ? args.command : "";
    if (command.trim().length === 0) return { ok: false, output: "command is required" };
    if (context.confirmShell && !(await context.confirmShell(command))) {
      return { ok: false, output: "the user declined to run this command; continue without it" };
    }
    const timeoutMs = Math.min(
      typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 60_000,
      context.commandTimeoutMs ?? 300_000,
    );
    const cwd = resolveIn(context, args.cwd);
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      return { ok: false, output: `working directory does not exist: ${cwd}` };
    }
    const isWindows = process.platform === "win32";
    const result = spawnSync(isWindows ? "cmd" : "sh", [isWindows ? "/c" : "-c", command], {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    const parts: string[] = [];
    if (result.stdout) parts.push(truncate(result.stdout, MAX_OUTPUT / 2));
    if (result.stderr) parts.push(truncate(result.stderr, MAX_OUTPUT / 2));
    let ok = true;
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOBUFS") {
        // The command produced more output than the capture buffer; the
        // partial stdout we did capture is still useful to the model.
        parts.push("warning: output exceeded the capture buffer; pipe through tail/head for large outputs");
      } else {
        ok = false;
        parts.push(`error: ${(result.error as Error).message}`);
      }
    } else if (result.status !== 0) {
      ok = false;
      const signal = result.signal ? ` (signal ${result.signal})` : "";
      parts.push(`exit code: ${result.status ?? "null"}${signal}`);
    }
    if (parts.length === 0) parts.push("(no output)");
    return { ok, output: parts.join("\n") };
  },
};

const webFetchTool: ToolContext2 = {
  name: "web_fetch",
  description:
    "Fetch a public http(s) URL and return its response body as text (max 32 KB). Private network addresses are blocked.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL." },
    },
    required: ["url"],
  },
  execute: async (args, context) => {
    void context;
    const url = typeof args.url === "string" ? args.url : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, output: `invalid URL: ${url}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, output: `only http(s) URLs are allowed, got ${parsed.protocol}` };
    }
    try {
      const addresses = await dns.lookup(parsed.hostname, { all: true });
      for (const address of addresses) {
        if (isPrivateAddress(address.address)) {
          return { ok: false, output: `blocked: ${parsed.hostname} resolves to a private address (${address.address})` };
        }
      }
    } catch {
      return { ok: false, output: `cannot resolve host: ${parsed.hostname}` };
    }
    try {
      const response = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (!response.ok) {
        return { ok: false, output: `HTTP ${response.status} ${response.statusText} for ${parsed}` };
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      const textLike =
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("javascript") ||
        contentType.length === 0;
      if (!textLike) {
        return { ok: false, output: `refused non-text content-type: ${contentType || "unknown"} for ${parsed}` };
      }
      const text = await response.text();
      return { ok: true, output: truncate(text.slice(0, 32_000), 32_000) };
    } catch (error) {
      return { ok: false, output: `fetch failed: ${(error as Error).message}` };
    }
  },
};

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

const memoryReadTool: ToolContext2 = {
  name: "memory_read",
  description:
    "Read this environment's persistent memory (memory/MEMORY.md) — durable facts, decisions, and preferences recorded across sessions. Empty when nothing recorded yet.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: (_args, context) => {
    const file = path.join(context.envRoot, "memory", "MEMORY.md");
    try {
      return { ok: true, output: truncate(readFileSync(file, "utf8")) };
    } catch {
      return { ok: true, output: "(memory is empty)" };
    }
  },
};

const memoryWriteTool: ToolContext2 = {
  name: "memory_write",
  description:
    'Append a durable fact to persistent memory (survives sessions). Keep entries one per line, e.g. "- 2026-09-12: user prefers vitest over jest". Do not store secrets.',
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "One memory entry (a single line or short paragraph)." },
    },
    required: ["content"],
  },
  execute: (args, context) => {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (content.length === 0) return { ok: false, output: "content is required" };
    if (content.includes("\n")) {
      return { ok: false, output: "write one entry per memory_write call (no newlines)" };
    }
    const dir = path.join(context.envRoot, "memory");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "MEMORY.md");
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "# Environment memory\n";
    const entry = content.startsWith("- ") ? content : `- ${content}`;
    writeFileSync(file, `${existing}${existing.endsWith("\n") ? "" : "\n"}${entry}\n`, "utf8");
    return { ok: true, output: `remembered: ${content.slice(0, 120)}` };
  },
};

const agentSendTool: ToolContext2 = {
  name: "agent_send",
  description:
    'Send a message to a peer harness (another skillenv agent in a different environment). Arguments: {"to": "<peer env name>", "message": "<your full message text>"}. Keep message a single JSON string (escape inner quotes). Use for delegation, handoffs, and coordination.',
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Peer environment name (must be one of the declared peers)." },
      message: { type: "string", description: "Full message text (subject and body in one string)." },
      subject: { type: "string", description: "Optional short subject line; defaults to the first line of message." },
    },
    required: ["to", "message"],
  },
  execute: (args, context) => {
    const to = typeof args.to === "string" ? args.to : "";
    const peer = (context.peers ?? []).find((candidate) => candidate.name === to);
    if (!peer) {
      const known = (context.peers ?? []).map((candidate) => candidate.name).join(", ") || "none";
      return { ok: false, output: `unknown peer '${to}'; available peers: ${known}` };
    }
    const message = typeof args.message === "string" ? args.message : "";
    if (message.trim().length === 0) return { ok: false, output: "message is required" };
    const explicitSubject = typeof args.subject === "string" && args.subject.trim().length > 0 ? args.subject.trim() : "";
    const subject = explicitSubject || (message.split("\n")[0] ?? "").slice(0, 80) || "(no subject)";
    const id = sendMail({
      fromEnv: context.envName ?? "",
      fromRoot: context.envRoot,
      toEnv: to,
      toRoot: peer.envRoot,
      subject,
      body: message,
    });
    return { ok: true, output: `message ${id} delivered to peer '${to}'` };
  },
};

const agentInboxTool: ToolContext2 = {
  name: "agent_inbox",
  description:
    "Check your mailbox for messages from peer harnesses. Unread messages are returned and marked read.",
  parameters: {
    type: "object",
    properties: {
      all: { type: "boolean", description: "Include already-read messages." },
    },
    required: [],
  },
  execute: (args, context) => {
    const includeAll = args.all === true;
    const messages = listMail(context.envRoot, { unreadOnly: !includeAll });
    if (messages.length === 0) return { ok: true, output: "(mailbox empty)" };
    const rendered = messages
      .map((message) => {
        const state = message.read ? "[read]" : "[unread]";
        return `${state} ${message.id} from=${message.from} subject=${message.subject}\n${message.body.slice(0, 2000)}`;
      })
      .join("\n---\n");
    for (const message of messages) {
      if (!message.read) markMailRead(context.envRoot, message.id);
    }
    return { ok: true, output: truncate(rendered) };
  },
};

const skillListTool: ToolContext2 = {
  name: "skill_list",
  description: "List the skills installed in the current skillenv environment with their descriptions.",
  parameters: { type: "object", properties: {}, required: [] },
  execute: (_args, context) => {
    const skillsDir = path.join(context.envRoot, "skills");
    if (!statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
      return { ok: true, output: "(no skills installed)" };
    }
    const skills = readdirSync(skillsDir)
      .sort()
      .filter((entry) => statSync(path.join(skillsDir, entry), { throwIfNoEntry: false })?.isDirectory())
      .map((entry) => {
        const meta = readSkillMeta(path.join(skillsDir, entry));
        return `${entry}: ${meta.description ?? "(no description)"}`;
      });
    return { ok: true, output: skills.length > 0 ? skills.join("\n") : "(no skills installed)" };
  },
};

const skillReadTool: ToolContext2 = {
  name: "skill_read",
  description: "Read the full SKILL.md of an installed skill. Use before following a skill's instructions.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Skill directory name as shown by skill_list." },
    },
    required: ["name"],
  },
  execute: (args, context) => {
    const name = typeof args.name === "string" ? args.name : "";
    if (name.includes("/") || name.includes("..") || name.length === 0) {
      return { ok: false, output: "invalid skill name" };
    }
    const file = path.join(context.envRoot, "skills", name, SKILL_FILE);
    if (!existsSync(file)) {
      return { ok: false, output: `skill not found: ${name}` };
    }
    return { ok: true, output: truncate(readFileSync(file, "utf8")) };
  },
};

/** The default agent toolbox. */
export function defaultTools(): ToolContext2[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    runCommandTool,
    webFetchTool,
    skillListTool,
    skillReadTool,
    memoryReadTool,
    memoryWriteTool,
    agentSendTool,
    agentInboxTool,
  ];
}

export function toolSchemas(tools: ToolContext2[]): import("./providers.js").ToolSchema[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

export async function executeTool(
  tools: ToolContext2[],
  context: ToolContext,
  call: import("./providers.js").ToolCall,
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === call.function.name);
  if (!tool) {
    return { ok: false, output: `unknown tool: ${call.function.name}` };
  }
  let args: Record<string, unknown> = {};
  if (call.function.arguments.trim().length > 0) {
    const parseArgs = (raw: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    let parsed = parseArgs(call.function.arguments);
    if (parsed === null) {
      // Models occasionally emit `{to": "x"}` — a key missing its opening
      // quote. Repair that exact shape before giving up: `[{,] key":` → `{"key":`.
      const repaired = call.function.arguments.replace(
        /([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(")/g,
        '$1"$2$3',
      );
      parsed = parseArgs(repaired);
    }
    if (parsed === null) {
      // Echo the malformed arguments so the model can see and repair them.
      return {
        ok: false,
        output: `tool arguments are not valid JSON: could not parse.\nyou sent: ${truncate(call.function.arguments, 400)}\nFix the JSON (escape inner quotes, quote every key) and retry.`,
      };
    }
    args = parsed;
  }
  try {
    return await tool.execute(args, context);
  } catch (error) {
    return { ok: false, output: `tool crashed: ${(error as Error).message}` };
  }
}
