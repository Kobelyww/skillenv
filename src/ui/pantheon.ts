import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defaultHome } from "../config.js";
import { createEnv, getEnv, ENV_SUBDIRS } from "../env.js";
import { runAgentTurn, presentSkillNames, skillSummary } from "../agent/loop.js";
import { createSession, listSessions, saveSession, type AgentSession } from "../agent/session.js";
import { listMail } from "../agent/mailbox.js";
import { resolveProvider, type ChatMessage, type ResolvedProvider } from "../agent/providers.js";
import { renderPage } from "./page.js";

/**
 * Pantheon — a round-table client where every "god" is a fully isolated
 * agent harness: its own skillenv environment (skills, sessions, memory,
 * mailbox), its own provider credentials, and its own persona. The server
 * is only an orchestrator; harnesses share nothing except the answers that
 * are deliberately passed between them during debate rounds.
 */

export interface GodHarness {
  name: string;
  envRoot: string;
  persona: string;
  /** Fully isolated per-god provider (credentials and model). */
  provider: ResolvedProvider;
}

export interface PantheonOptions {
  gods: GodHarness[];
  workdir: string;
}

const DEFAULT_GOD_ROSTER = ["hermes", "athena", "hephaestus"] as const;

const PERSONAS: Record<string, string> = {
  hermes:
    "You are 赫尔墨斯 Hermes, messenger of the gods: swift, concise, pragmatic. You answer first and fast, cutting to what matters. 2-6 sentences unless code is required.",
  athena:
    "You are 雅典娜 Athena, goddess of wisdom and strategy: you analyze structure, risks, and trade-offs others miss. Precise and measured.",
  hephaestus:
    "You are 赫菲斯托斯 Hephaestus, the divine smith: you build and verify concrete artifacts. You trust only executed code and show the essential diff.",
  poseidon:
    "You are 波塞冬 Poseidon, lord of the deep: you stress systems, hunt failure modes and edge cases, and surface what breaks under pressure.",
  apollo:
    "You are 阿波罗 Apollo, god of light and clarity: you explain, document, and make the complex legible.",
};

function personaFor(envName: string): string {
  const key = envName.toLowerCase();
  for (const [roster, text] of Object.entries(PERSONAS)) {
    if (key.includes(roster)) return text;
  }
  return `You are ${envName}, one of the gods of the pantheon: an autonomous agent with your own skills and memory. Speak with a distinct, useful point of view.`;
}

/** Per-god provider isolation: SKILLENV_GOD_<NAME>_PROVIDER/_MODEL/_BASE_URL/_API_KEY override the shared config. */
export function resolveGodProvider(godName: string, shared: ResolvedProvider): ResolvedProvider {
  const upper = godName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const providerId = process.env[`SKILLENV_GOD_${upper}_PROVIDER`];
  const model = process.env[`SKILLENV_GOD_${upper}_MODEL`];
  const baseUrl = process.env[`SKILLENV_GOD_${upper}_BASE_URL`];
  const apiKey = process.env[`SKILLENV_GOD_${upper}_API_KEY`];
  if (!providerId && !model && !baseUrl && !apiKey) return shared;
  try {
    return resolveProvider({
      provider: providerId ?? shared.id,
      model: model ?? shared.model,
      baseUrl: baseUrl ?? (shared.id === shared.id ? undefined : undefined),
      apiKey: apiKey ?? shared.apiKey,
    });
  } catch {
    return shared;
  }
}

/** Resolve the god roster: create missing default gods (zero-config), resolve personas and providers. */
export function resolveGods(
  requested: string[],
  sharedProvider: ResolvedProvider,
  personaOverrides: Record<string, string> = {},
  home = defaultHome(),
): GodHarness[] {
  const names = requested.length > 0 ? requested : [...DEFAULT_GOD_ROSTER];
  // Missing god environments are created on demand — the pantheon is
  // zero-config: point it at names and it bootstraps the whole roster.
  return names.map((name) => {
    let envRoot: string;
    try {
      envRoot = getEnv(name, home).root;
    } catch {
      envRoot = createEnv(name, home).root;
    }
    return {
      name,
      envRoot,
      persona: personaOverrides[name] ?? personaFor(name),
      provider: resolveGodProvider(name, sharedProvider),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("request body is not valid JSON");
  }
}

const GOD_SYSTEM_SUFFIX =
  "\nYou sit on the Pantheon round table: other gods hear your answers and you hear theirs. Stay in character, answer in the user's language, and be useful.";

export function createPantheonServer(options: PantheonOptions): Server {
  const { workdir } = options;
  // Fully isolated per-god harness state: conversations live per god and are
  // persisted inside that god's own environment.
  const sessions = new Map<string, AgentSession>();

  const sessionFor = (god: GodHarness): AgentSession => {
    const existing = sessions.get(god.name);
    if (existing) return existing;
    const latest = listSessions(god.envRoot).at(-1);
    const session = latest ?? createSession(god.envRoot, god.name, god.provider.id, god.provider.model);
    sessions.set(god.name, session);
    return session;
  };

  const godTurnOptions = (god: GodHarness, signal?: AbortSignal) => ({
    envRoot: god.envRoot,
    envName: god.name,
    provider: god.provider,
    workdir,
    systemExtra: god.persona + GOD_SYSTEM_SUFFIX,
    signal,
  });

  async function runGodTurn(
    res: ServerResponse,
    god: GodHarness,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await runAgentTurn(
      godTurnOptions(god, signal),
      messages,
      {
        onTextDelta: (text) => sse(res, "god-delta", { god: god.name, text }),
        onTurnStart: () => {},
        onToolCall: (name, args) => sse(res, "god-tool", { god: god.name, name, args }),
        onToolResult: (name, ok, output) =>
          sse(res, "god-tool-result", { god: god.name, name, ok, preview: output.slice(0, 400) }),
        onInfo: (line) => sse(res, "god-info", { god: god.name, line }),
      },
    );
    saveSession(god.envRoot, sessionFor(god));
    return result.content;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        const body = renderPage({
          gods: options.gods.map((god) => ({
            name: god.name,
            persona: god.persona,
            provider: god.provider.id,
            model: god.provider.model,
            skills: presentSkillNames(god.envRoot).map((name) => ({
              name,
              description: skillSummary(god.envRoot, name),
            })),
          })),
          providers: ["deepseek", "nous", "glm", "openai", "ollama", "modelarts", "anthropic"],
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            gods: options.gods.map((god) => ({
              name: god.name,
              persona: god.persona,
              provider: god.provider.id,
              model: god.provider.model,
              skills: presentSkillNames(god.envRoot).map((name) => ({
                name,
                description: skillSummary(god.envRoot, name),
              })),
              unread: listMail(god.envRoot, { unreadOnly: true }).length,
            })),
            workdir,
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/memory") {
        const godName = url.searchParams.get("god") ?? "";
        const god = options.gods.find((candidate) => candidate.name === godName);
        if (!god) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `unknown god: ${godName}` }));
          return;
        }
        const memoryFile = path.join(god.envRoot, "memory", "MEMORY.md");
        const memory = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8") : "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ god: god.name, memory }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/inbox") {
        const godName = url.searchParams.get("god") ?? "";
        const god = options.gods.find((candidate) => candidate.name === godName);
        if (!god) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `unknown god: ${godName}` }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ god: god.name, messages: listMail(god.envRoot) }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        const body = await jsonBody(req);
        const godName = typeof body.god === "string" ? body.god : "";
        const god = options.gods.find((candidate) => candidate.name === godName);
        if (!god) throw new Error(`unknown god: ${godName}`);
        sessions.delete(god.name);
        const fresh = createSession(god.envRoot, god.name, god.provider.id, god.provider.model);
        sessions.set(god.name, fresh);
        saveSession(god.envRoot, fresh);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionId: fresh.id }));
        return;
      }

      const isRoundtable = req.method === "POST" && url.pathname === "/api/roundtable";
      const isSolo = req.method === "POST" && url.pathname === "/api/solo";
      if (isRoundtable || isSolo) {
        const body = await jsonBody(req);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (prompt.length === 0) throw new Error("prompt is required");
        const rounds = isRoundtable ? Math.max(1, Math.min(3, Number(body.rounds ?? 1) || 1)) : 1;
        const soloGodName = isSolo ? String(body.god ?? "") : "";
        const soloGod = isSolo ? options.gods.find((candidate) => candidate.name === soloGodName) : undefined;
        if (isSolo && !soloGod) throw new Error(`unknown god: ${soloGodName}`);

        // Optional runtime provider/model switch (isolation preserved: applied
        // per god, per request).
        const reqProvider = typeof body.provider === "string" ? body.provider : undefined;
        const reqModel = typeof body.model === "string" ? body.model : undefined;
        if (reqProvider || reqModel) {
          for (const god of options.gods) {
            const upper = god.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
            const perGod = process.env[`SKILLENV_GOD_${upper}_PROVIDER`] || process.env[`SKILLENV_GOD_${upper}_MODEL`];
            if (!perGod) {
              god.provider = resolveProvider({
                provider: reqProvider ?? god.provider.id,
                model: reqModel ?? god.provider.model,
                apiKey: god.provider.apiKey,
              });
            }
          }
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const controller = new AbortController();
        req.on("close", () => controller.abort());

        try {
          if (isSolo && soloGod) {
            try {
              const session = sessionFor(soloGod);
              session.messages.push({ role: "user", content: prompt });
              const content = await runGodTurn(res, soloGod, session.messages, controller.signal);
              sse(res, "done", { god: soloGod.name, content });
            } catch (error) {
              if (!controller.signal.aborted) {
                sse(res, "god-error", { god: soloGod.name, message: (error as Error).message.slice(0, 300) });
                sse(res, "done", { god: soloGod.name, content: null });
              }
            }
            res.end();
            return;
          }

          // --- Round table -------------------------------------------------
          const answers = new Map<string, string>();
          sse(res, "phase", { phase: "answer", round: 1 });

          await Promise.all(
            options.gods.map(async (god) => {
              try {
                const session = sessionFor(god);
                session.messages.push({ role: "user", content: prompt });
                const content = await runGodTurn(res, god, session.messages, controller.signal);
                answers.set(god.name, content);
              } catch (error) {
                if (controller.signal.aborted) return;
                sse(res, "god-error", { god: god.name, message: (error as Error).message.slice(0, 300) });
                answers.set(god.name, `(error: ${(error as Error).message.slice(0, 120)})`);
              }
            }),
          );

          for (let round = 2; round <= rounds; round++) {
            if (controller.signal.aborted) break;
            sse(res, "phase", { phase: "debate", round });
            await Promise.all(
              options.gods.map(async (god) => {
                try {
                  const others = options.gods
                    .filter((other) => other.name !== god.name)
                    .map((other) => `【${other.name}】\n${answers.get(other.name) ?? "(no answer)"}`)
                    .join("\n\n");
                  const session = sessionFor(god);
                  session.messages.push({
                    role: "user",
                    content: `圆桌第 ${round} 轮：其他神的回答如下：\n\n${others}\n\n请简要回应（认同/纠正/补充，2-4 句；如需代码只给关键片段）。`,
                  });
                  const content = await runGodTurn(res, god, session.messages, controller.signal);
                  answers.set(god.name, content);
                } catch (error) {
                  if (!controller.signal.aborted) {
                    sse(res, "god-error", { god: god.name, message: (error as Error).message.slice(0, 300) });
                  }
                }
              }),
            );
          }

          // Synthesis by the chair (first god), streamed into its own panel.
          if (!controller.signal.aborted) {
            sse(res, "phase", { phase: "synthesis" });
            const chair = options.gods[0];
            if (chair) {
              const all = options.gods
                .map((god) => `【${god.name}】\n${answers.get(god.name) ?? "(no answer)"}`)
                .join("\n\n");
              try {
                const session = sessionFor(chair);
                session.messages.push({
                  role: "user",
                  content: `圆桌结束。众神的最终回答如下：\n\n${all}\n\n请作为主持神给出综合结论：共识、分歧、以及最终建议。`,
                });
                const content = await runGodTurn(res, chair, session.messages, controller.signal);
                sse(res, "done", { god: chair.name, content });
                res.end();
                return;
              } catch (error) {
                if (!controller.signal.aborted) {
                  sse(res, "god-error", { god: chair.name, message: (error as Error).message.slice(0, 300) });
                }
              }
            }
          }
          sse(res, "done", { god: null, content: null });
          res.end();
          return;
        } catch (error) {
          if (!controller.signal.aborted) {
            sse(res, "error", { message: (error as Error).message.slice(0, 300) });
            res.end();
          }
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).message.slice(0, 300) }));
    }
  });

  // Long round-table streams must not be cut by Node's default timeouts.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

/** Start the server and return the bound URL. */
export function listenPantheon(options: PantheonOptions, port: number): Promise<{ server: Server; url: string }> {
  const server = createPantheonServer(options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Ensure the standard layout for a god env (used by the CLI before launch). */
export function ensureGodEnv(name: string, home: string): string {
  const env = createEnv(name, home);
  for (const dir of ENV_SUBDIRS) {
    const target = path.join(env.root, dir);
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  }
  return env.root;
}

/** List sessions of a god (for tests/CLI introspection). */
export function godSessions(envRoot: string): AgentSession[] {
  return listSessions(envRoot);
}

