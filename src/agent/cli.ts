import { createInterface } from "node:readline/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import pc from "picocolors";
import { Command } from "commander";
import { defaultHome } from "../config.js";
import { getEnv, type Env } from "../env.js";
import {
  addSessionUsage,
  createSession,
  listSessions,
  loadSession,
  saveSession,
  sessionToMarkdown,
  sessionTokenCount,
  type AgentSession,
} from "./session.js";
import { endTurn, quietRender, terminalRender, type AgentRenderEvents } from "./render.js";
import { resolveProvider, type ChatMessage } from "./providers.js";
import { envSkillNames, presentSkillNames, presentToolNames, runAgentTurn, type AgentTurnResult } from "./loop.js";

function fail(message: string): never {
  process.stderr.write(`${pc.red("error:")} ${message}\n`);
  process.exit(1);
}

function mustGetEnv(envName: string): Env {
  try {
    return getEnv(envName, defaultHome());
  } catch (error) {
    fail((error as Error).message);
  }
}

interface EvalCliOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  report?: string;
  keepWorkdirs?: boolean;
  maxIterations?: string;
  case?: string;
}

interface AgentCliOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  tools?: string;
  dir?: string;
  skills?: string;
  systemExtra?: string;
  peers?: string;
  session?: string;
  continueSession?: boolean;
  confirmShell?: boolean;
  quiet?: boolean;
  maxIterations?: string;
  maxTokens?: string;
  compactChars?: string;
  temperature?: string;
}

/** Register `agent` and `session` commands on the root program. */
export function registerAgentCommands(program: Command): void {
  program
    .command("agent <env>")
    .description(
      "Run the built-in coding agent inside an environment. Providers: deepseek, nous (Hermes), glm, openai, ollama, modelarts, anthropic.",
    )
    .option("-p, --provider <id>", "Provider preset (default: deepseek).")
    .option("-m, --model <model>", "Model name (defaults to the provider preset).")
    .option("--base-url <url>", "Override the provider base URL.")
    .option("--api-key <key>", "Override the API key (else the provider's env var).")
    .option("--fallback-provider <id>", "Failover provider used when the primary fails before any output.")
    .option("--fallback-model <model>", "Model for the fallback provider.")
    .option("--tools <names>", "Comma-separated tool allowlist (default: all tools).")
    .option("--confirm-shell", "Ask before every shell command (interactive terminals only).", false)
    .option("--dir <path>", "Working directory for tools (default: current directory).")
    .option("--skills <names>", "Comma-separated skill names to inline into the system prompt.")
    .option("--system-extra <text>", "Extra instructions appended to the agent system prompt.")
    .option("--peers <envs>", "Comma-separated peer environment names this agent can message.")
    .option("-s, --session <id>", "Reuse an existing session.")
    .option("-c, --continue", "Continue the most recent session.", false)
    .option("-q, --quiet", "Suppress tool rendering (assistant text only).", false)
    .option("--max-iterations <n>", "Maximum tool-loop iterations per turn.", "25")
    .option("--max-tokens <n>", "Max output tokens per completion.")
    .option("--compact-chars <n>", "Conversation char budget before compaction (0 disables).", "120000")
    .option("--temperature <x>", "Sampling temperature.")
    .argument("[prompt]", "One-shot prompt; omit for an interactive REPL.")
    .action(async (envName: string, prompt: string | undefined, options: AgentCliOptions) => {
      await runAgentCommand(envName, prompt, options);
    });

  program
    .command("agent-eval <suite> <env>")
    .description("Run a YAML agent evaluation suite (tool-sequence, file, and exit-code assertions).")
    .option("-p, --provider <id>", "Provider preset (default: deepseek).")
    .option("-m, --model <model>", "Model name.")
    .option("--base-url <url>", "Override the provider base URL.")
    .option("--api-key <key>", "Override the API key.")
    .option("--fallback-provider <id>", "Failover provider.")
    .option("--fallback-model <model>", "Model for the fallback provider.")
    .option("--report <file>", "Write a JSON report to this file.")
    .option("--keep-workdirs", "Keep per-case workdirs for inspection.", false)
    .option("--max-iterations <n>", "Default iteration cap for cases without their own.", "25")
    .option("--case <name>", "Run only the case whose name contains this substring.")
    .action(async (suiteFile: string, envName: string, options: EvalCliOptions) => {
      const { loadEvalSuite, runEvalSuite } = await import("./eval.js");
      const env = mustGetEnv(envName);
      let provider;
      try {
        provider = resolveProvider({
          provider: options.provider,
          model: options.model,
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
        });
      } catch (error) {
        fail((error as Error).message);
      }
      let fallbackProvider;
      if (options.fallbackProvider) {
        try {
          fallbackProvider = resolveProvider({
            provider: options.fallbackProvider,
            model: options.fallbackModel,
          });
        } catch (error) {
          fail(`fallback provider: ${(error as Error).message}`);
        }
      }
      let suite;
      try {
        suite = loadEvalSuite(suiteFile);
      } catch (error) {
        fail((error as Error).message);
      }
      process.stderr.write(
        `${pc.dim(`agent-eval ${suite.name} · ${suite.cases.length} case(s) · ${provider.id}/${provider.model}`)}\n`,
      );
      const report = await runEvalSuite(suite as NonNullable<typeof suite>, {
        envRoot: env.root,
        envName: env.name,
        provider,
        fallbackProvider,
        workdir: process.cwd(),
        keepWorkdirs: options.keepWorkdirs,
        render: terminalRender(),
        defaultMaxIterations: Math.max(1, Number.parseInt(options.maxIterations ?? "25", 10) || 25),
        onlyCase: options.case,
      });
      for (const result of report.results) {
        const mark = result.passed ? pc.green("✓") : pc.red("✗");
        process.stdout.write(`${mark} ${result.name}  tools=[${result.toolNames.join(", ")}]\n`);
        for (const failure of result.failures) {
          process.stdout.write(`    ${pc.red(failure)}\n`);
        }
      }
      process.stdout.write(
        `${report.passed}/${report.total} passed (rate=${report.passRate.toFixed(2)})\n`,
      );
      if (options.report) {
        writeFileSync(path.resolve(options.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
        process.stdout.write(`report: ${path.resolve(options.report)}\n`);
      }
      if (report.passed < report.total) {
        process.exit(1);
      }
    });

  const sessionApp = program.command("session").description("Inspect agent sessions.");

  sessionApp
    .command("list <env>")
    .description("List agent sessions recorded in an environment.")
    .action((envName: string) => {
      const env = mustGetEnv(envName);
      const sessions = listSessions(env.root);
      if (sessions.length === 0) {
        process.stdout.write("no sessions\n");
        return;
      }
      for (const session of sessions) {
        const tokens = sessionTokenCount(session);
        const usage = tokens === undefined ? "" : `\t${tokens} tok`;
        process.stdout.write(
          `${session.id}\t${session.provider}/${session.model}\t${session.messages.length} msgs${usage}\t${session.updated_at}\n`,
        );
      }
    });

  sessionApp
    .command("export <env> <id>")
    .description("Export a session transcript as Markdown (default: stdout; --out writes a file).")
    .option("-o, --out <file>", "Write to this file instead of stdout.")
    .action((envName: string, id: string, options: { out?: string }) => {
      const env = mustGetEnv(envName);
      try {
        const session = loadSession(env.root, id);
        const markdown = sessionToMarkdown(session);
        if (options.out) {
          writeFileSync(path.resolve(options.out), markdown, "utf8");
          process.stdout.write(`exported ${session.id} -> ${path.resolve(options.out)}\n`);
        } else {
          process.stdout.write(markdown);
        }
      } catch (error) {
        fail((error as Error).message);
      }
    });

  sessionApp
    .command("show <env> <id>")
    .description("Print the message transcript of one session.")
    .action((envName: string, id: string) => {
      const env = mustGetEnv(envName);
      try {
        const session = loadSession(env.root, id);
        for (const message of session.messages) {
          const label = message.role === "tool" ? `tool(${message.name ?? ""})` : message.role;
          process.stdout.write(`[${label}]\n${(message.content ?? "").slice(0, 4000)}\n\n`);
        }
      } catch (error) {
        fail((error as Error).message);
      }
    });
}

async function runAgentCommand(
  envName: string,
  prompt: string | undefined,
  options: AgentCliOptions,
): Promise<void> {
  const env = mustGetEnv(envName);
  let provider;
  try {
    provider = resolveProvider({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
    });
  } catch (error) {
    fail((error as Error).message);
  }

  let fallbackProvider: ReturnType<typeof resolveProvider> | undefined;
  if (options.fallbackProvider) {
    try {
      fallbackProvider = resolveProvider({
        provider: options.fallbackProvider,
        model: options.fallbackModel,
      });
    } catch (error) {
      fail(`fallback provider: ${(error as Error).message}`);
    }
  }

  const workdir = path.resolve(options.dir ?? process.cwd());
  if (!statSync(workdir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`workdir does not exist: ${workdir}`);
  }
  const maxIterations = Math.max(1, Number.parseInt(options.maxIterations ?? "25", 10) || 25);
  const parsedTemperature =
    options.temperature !== undefined ? Number.parseFloat(options.temperature) : Number.NaN;
  const temperature = Number.isNaN(parsedTemperature) ? undefined : parsedTemperature;
  const maxTokens =
    options.maxTokens !== undefined ? Number.parseInt(options.maxTokens, 10) || undefined : undefined;
  const inlineSkills = (options.skills ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const toolAllowlist = (options.tools ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  let confirmShell: ((command: string) => Promise<boolean>) | undefined;
  if (options.confirmShell) {
    if (!process.stdin.isTTY) {
      fail("--confirm-shell requires an interactive terminal");
    }
    confirmShell = async (command) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (
          await rl.question(`${pc.yellow(`run command? ${command.slice(0, 200)}\n[y/N] `)}`)
        )
          .trim()
          .toLowerCase();
        return answer === "y" || answer === "yes";
      } finally {
        rl.close();
      }
    };
  }

  const render: AgentRenderEvents = options.quiet ? quietRender() : terminalRender();

  // Session selection: explicit id > --continue (latest) > fresh.
  let session: AgentSession;
  if (options.session) {
    try {
      session = loadSession(env.root, options.session);
    } catch (error) {
      fail((error as Error).message);
    }
  } else if (options.continueSession) {
    // Same-second sessions share a filename prefix; pick by updated_at.
    const latest = listSessions(env.root).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (!latest) fail("no previous session to continue");
    session = latest as AgentSession;
  } else {
    session = createSession(env.root, env.name, provider.id, provider.model);
  }
  session.provider = provider.id;
  session.model = provider.model;

  const peers = (options.peers ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name: string) => {
      try {
        return { name, envRoot: getEnv(name, defaultHome()).root };
      } catch {
        // Not a local environment: treat as a remote peer reachable via mail sync.
        return { name };
      }
    });
  const compactChars = Number.parseInt(options.compactChars ?? "120000", 10);
  const agentOptions = {
    envRoot: env.root,
    envName: env.name,
    provider,
    fallbackProvider,
    tools: toolAllowlist.length > 0 ? toolAllowlist : undefined,
    confirmShell,
    peers,
    workdir,
    inlineSkills,
    systemExtra: options.systemExtra,
    maxIterations,
    temperature,
    maxTokens,
    compactChars: Number.isNaN(compactChars) ? undefined : compactChars,
  };

  const skills = presentSkillNames(env.root);
  process.stderr.write(
    `${pc.dim(`skillenv agent · env=${env.name} · ${provider.displayName} · model=${provider.model} · skills=${skills.length > 0 ? skills.join(",") : "-"} · workdir=${workdir}`)}\n`,
  );

  const interactive = prompt === undefined && process.stdin.isTTY;
  const pipedPrompt =
    prompt ?? (process.stdin.isTTY ? undefined : await readPipedStdin());

  if (!interactive) {
    const effectivePrompt = (pipedPrompt ?? "").trim();
    if (effectivePrompt.length === 0) {
      fail("no prompt given; pass one as an argument or pipe text to stdin");
    }
    session.messages.push({ role: "user", content: effectivePrompt });
    let turn;
    try {
      turn = await runAgentTurn(agentOptions, session.messages as ChatMessage[], render);
    } catch (error) {
      fail((error as Error).message);
    }
    endTurn();
    render.onInfo(usageLine(turn));
    addSessionUsage(session, turn.usage);
    session.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    saveSession(env.root, session);
    exitFlushed(0);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stderr.write(
    `${pc.dim("interactive REPL — /exit /sessions /skills /tools /memory /export [file]")}\n`,
  );

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(pc.green("you> "))).trim();
      } catch {
        // Ctrl+D / closed stdin: leave the REPL the same way /exit would.
        break;
      }
      if (line.length === 0) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/sessions") {
        for (const listed of listSessions(env.root)) {
          const tokens = sessionTokenCount(listed);
          const usage = tokens === undefined ? "" : `\t${tokens} tok`;
          process.stdout.write(
            `${listed.id}\t${listed.provider}/${listed.model}\t${listed.messages.length} msgs${usage}\n`,
          );
        }
        continue;
      }
      if (line === "/skills") {
        for (const name of envSkillNames(env.root)) {
          process.stdout.write(`${name}\n`);
        }
        continue;
      }
      if (line === "/memory") {
        const memoryFile = path.join(env.root, "memory", "MEMORY.md");
        try {
          process.stdout.write(readFileSync(memoryFile, "utf8"));
        } catch {
          process.stdout.write("(memory is empty)\n");
        }
        continue;
      }
      if (line === "/tools") {
        for (const name of presentToolNames(agentOptions.tools)) {
          process.stdout.write(`${name}\n`);
        }
        continue;
      }
      if (line.startsWith("/export")) {
        const target = line.split(/\s+/)[1];
        const markdown = sessionToMarkdown(session);
        if (target) {
          writeFileSync(path.resolve(target), markdown, "utf8");
          process.stderr.write(`${pc.dim(`exported to ${path.resolve(target)}`)}\n`);
        } else {
          process.stdout.write(markdown);
        }
        continue;
      }
      if (line.startsWith("/")) {
        process.stderr.write(`${pc.dim(`unknown command: ${line}`)}\n`);
        continue;
      }

      session.messages.push({ role: "user", content: line });
      let turn;
      try {
        turn = await runAgentTurn(agentOptions, session.messages as ChatMessage[], render);
      } catch (error) {
        process.stderr.write(`${pc.red("error:")} ${(error as Error).message}\n`);
        session.messages.pop();
        continue;
      }
      endTurn();
      render.onInfo(usageLine(turn));
      addSessionUsage(session, turn.usage);
      session.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      saveSession(env.root, session);
    }
  } finally {
    rl.close();
  }
}

function usageLine(turn: AgentTurnResult): string {
  const tokens = turn.usage.prompt_tokens + turn.usage.completion_tokens;
  if (tokens === 0) return `${turn.iterations} iteration(s) · ${turn.toolCalls} tool call(s)`;
  return `${turn.iterations} iteration(s) · ${turn.toolCalls} tool call(s) · ${tokens} tokens (in ${turn.usage.prompt_tokens} / out ${turn.usage.completion_tokens})`;
}

async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Exit after pending stdout writes flush. One-shot runs may be invoked by
 * parents that hold the stdin pipe open; without this the process would
 * linger after finishing its work.
 */
function exitFlushed(code: number): void {
  const stream = process.stdout;
  if (stream.writableLength === 0) {
    process.exit(code);
  }
  stream.write("", () => process.exit(code));
}
