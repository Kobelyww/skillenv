import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";
import pc from "picocolors";
import { Command } from "commander";
import { defaultHome } from "../config.js";
import { getEnv, type Env } from "../env.js";
import {
  createSession,
  listSessions,
  loadSession,
  saveSession,
  type AgentSession,
} from "./session.js";
import { endTurn, quietRender, terminalRender, type AgentRenderEvents } from "./render.js";
import { resolveProvider, type ChatMessage } from "./providers.js";
import { envSkillNames, presentSkillNames, runAgentTurn } from "./loop.js";

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
  session?: string;
  continueSession?: boolean;
  quiet?: boolean;
  maxIterations?: string;
  temperature?: string;
}

/** Register `agent` and `session` commands on the root program. */
export function registerAgentCommands(program: Command): void {
  program
    .command("agent <env>")
    .description(
      "Run the built-in coding agent inside an environment. Providers: deepseek, nous (Hermes), glm, openai, ollama, modelarts.",
    )
    .option("-p, --provider <id>", "Provider preset (default: deepseek).")
    .option("-m, --model <model>", "Model name (defaults to the provider preset).")
    .option("--base-url <url>", "Override the provider base URL.")
    .option("--api-key <key>", "Override the API key (else the provider's env var).")
    .option("--fallback-provider <id>", "Failover provider used when the primary fails before any output.")
    .option("--fallback-model <model>", "Model for the fallback provider.")
    .option("--tools <names>", "Comma-separated tool allowlist (default: all tools).")
    .option("--dir <path>", "Working directory for tools (default: current directory).")
    .option("--skills <names>", "Comma-separated skill names to inline into the system prompt.")
    .option("-s, --session <id>", "Reuse an existing session.")
    .option("-c, --continue", "Continue the most recent session.", false)
    .option("-q, --quiet", "Suppress tool rendering (assistant text only).", false)
    .option("--max-iterations <n>", "Maximum tool-loop iterations per turn.", "25")
    .option("--temperature <x>", "Sampling temperature.")
    .argument("[prompt]", "One-shot prompt; omit for an interactive REPL.")
    .action(async (envName: string, prompt: string | undefined, options: AgentCliOptions) => {
      await runAgentCommand(envName, prompt, options);
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
        process.stdout.write(
          `${session.id}\t${session.provider}/${session.model}\t${session.messages.length} msgs\t${session.updated_at}\n`,
        );
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
  const maxIterations = Math.max(1, Number.parseInt(options.maxIterations ?? "25", 10) || 25);
  const temperature =
    options.temperature !== undefined ? Number.parseFloat(options.temperature) : undefined;
  const inlineSkills = (options.skills ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const toolAllowlist = (options.tools ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

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
    const latest = listSessions(env.root).at(-1);
    if (!latest) fail("no previous session to continue");
    session = latest as AgentSession;
  } else {
    session = createSession(env.root, env.name, provider.id, provider.model);
  }
  session.provider = provider.id;
  session.model = provider.model;

  const agentOptions = {
    envRoot: env.root,
    envName: env.name,
    provider,
    fallbackProvider,
    tools: toolAllowlist.length > 0 ? toolAllowlist : undefined,
    workdir,
    inlineSkills,
    maxIterations,
    temperature,
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
    try {
      await runAgentTurn(agentOptions, session.messages as ChatMessage[], render);
    } catch (error) {
      fail((error as Error).message);
    }
    endTurn();
    session.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    saveSession(env.root, session);
    exitFlushed(0);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stderr.write(
    `${pc.dim("interactive REPL — /exit to quit, /sessions to list, /skills to show env skills")}\n`,
  );

  try {
    for (;;) {
      const line = (await rl.question(pc.green("you> "))).trim();
      if (line.length === 0) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/sessions") {
        for (const listed of listSessions(env.root)) {
          process.stdout.write(
            `${listed.id}\t${listed.provider}/${listed.model}\t${listed.messages.length} msgs\n`,
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
      if (line.startsWith("/")) {
        process.stderr.write(`${pc.dim(`unknown command: ${line}`)}\n`);
        continue;
      }

      session.messages.push({ role: "user", content: line });
      try {
        await runAgentTurn(agentOptions, session.messages as ChatMessage[], render);
      } catch (error) {
        process.stderr.write(`${pc.red("error:")} ${(error as Error).message}\n`);
        session.messages.pop();
        continue;
      }
      endTurn();
      session.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      saveSession(env.root, session);
    }
  } finally {
    rl.close();
  }
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
