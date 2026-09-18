import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnv } from "../src/env.js";
import { listenPantheon, resolveGods, resolveGodProvider } from "../src/ui/pantheon.js";
import type { ResolvedProvider } from "../src/agent/providers.js";
import { listSessions } from "../src/agent/session.js";

const HOME = mkdtempSync(path.join(tmpdir(), "pantheon-"));
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

/** Scripted provider mock: branches on the model name so each god gets its own script. */
function godMock(): string {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        model: string;
        messages: { role: string; content: string | null }[];
      };
      const god = parsed.model.replace("mock-", "");
      const last = parsed.messages.at(-1);
      const sawDebate = parsed.messages.some(
        (m) => m.role === "user" && String(m.content).includes("圆桌第 2 轮"),
      );
      const sawSynthesis = parsed.messages.some(
        (m) => m.role === "user" && String(m.content).includes("综合结论"),
      );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const toolCall = (id: string, name: string, args: unknown) =>
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`;
      const text = (t: string) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: "stop" }] })}\n\n`;

      if (sawSynthesis) {
        res.write(text(`综合：${god} 认为共识已达成。`));
      } else if (sawDebate) {
        const others = String(last?.content ?? "");
        res.write(text(`${god} 辩论轮：引用他人 -> ${others.includes("【") ? "saw peers" : "none"}`));
      } else if (god === "athena") {
        // Athena exercises a tool first to prove per-god tool loops work.
        if (parsed.messages.some((m) => m.role === "tool")) {
          res.write(text("雅典娜的结论。"));
        } else {
          res.write(toolCall("a1", "list_dir", {}));
        }
      } else {
        res.write(text(`${god}的第一轮回答。`));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`),
    );
  });
}

let baseUrl = "";
let aRoot = "";
let bRoot = "";

beforeAll(async () => {
  baseUrl = await godMock();
  aRoot = createEnv("hermes", HOME).root;
  bRoot = createEnv("athena", HOME).root;
});

function providerFor(god: string): ResolvedProvider {
  return { id: "openai", displayName: "Mock", baseUrl, apiKey: "", model: `mock-${god}` };
}

function collectSSE(response: Response): Promise<{ events: { event: string; data: any }[]; text: string }> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: any }[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = (): void => {
      reader
        .read()
        .then((r) => {
          if (r.done) {
            resolve({ events, text: "" });
            return;
          }
          buffer += decoder.decode(r.value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (data) {
              try {
                events.push({ event, data: JSON.parse(data) });
              } catch {
                /* ignore */
              }
            }
          }
          pump();
        })
        .catch(reject);
    };
    pump();
  });
}

describe("pantheon", () => {
  it("resolveGodProvider applies SKILLENV_GOD_<NAME>_* overrides", () => {
    const shared: ResolvedProvider = { id: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "shared", model: "deepseek-chat" };
    process.env.SKILLENV_GOD_HERMES_PROVIDER = "nous";
    process.env.SKILLENV_GOD_HERMES_MODEL = "Hermes-4-405B";
    const overridden = resolveGodProvider("hermes", shared);
    expect(overridden.id).toBe("nous");
    expect(overridden.model).toBe("Hermes-4-405B");
    expect(resolveGodProvider("athena", shared).id).toBe("deepseek");
    delete process.env.SKILLENV_GOD_HERMES_PROVIDER;
    delete process.env.SKILLENV_GOD_HERMES_MODEL;
  });

  it("serves the page and state", async () => {
    const { server, url } = await listenPantheon(
      {
        gods: resolveGods(["hermes", "athena"], providerFor("hermes"), {}, HOME).map(
          (god) => ({ ...god, provider: providerFor(god.name) }),
        ),
        workdir: HOME,
      },
      0,
    );
    servers.push(server);
    const page = await fetch(`${url}/`).then((r) => r.text());
    expect(page).toContain("PANTHEON");
    expect(page).toContain("hermes");
    const state = await fetch(`${url}/api/state`).then((r) => r.json());
    expect(state.gods.map((g: { name: string }) => g.name)).toEqual(["hermes", "athena"]);
    expect(state.gods[0].provider).toBe("openai");
  });

  it("solo chat streams one god and persists into that god's own session", async () => {
    const { server, url } = await listenPantheon(
      {
        gods: resolveGods(["hermes", "athena"], providerFor("hermes"), {}, HOME).map(
          (god) => ({ ...god, provider: providerFor(god.name) }),
        ),
        workdir: HOME,
      },
      0,
    );
    servers.push(server);
    const response = await fetch(`${url}/api/solo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ god: "athena", prompt: "给我结论" }),
    });
    const { events } = await collectSSE(response);
    const deltas = events.filter((e) => e.event === "god-delta");
    expect(deltas.every((e) => e.data.god === "athena")).toBe(true);
    expect(deltas.map((e) => e.data.text).join("")).toContain("雅典娜的结论");
    // Session persisted only inside Athena's env.
    const athenaSessions = listSessions(bRoot);
    expect(athenaSessions.length).toBeGreaterThan(0);
    expect(listSessions(aRoot).length).toBe(0);
  });

  it("round table: parallel answers, debate sees peers, chair synthesizes", async () => {
    const { server, url } = await listenPantheon(
      {
        gods: resolveGods(["hermes", "athena"], providerFor("hermes"), {}, HOME).map(
          (god) => ({ ...god, provider: providerFor(god.name) }),
        ),
        workdir: HOME,
      },
      0,
    );
    servers.push(server);
    const response = await fetch(`${url}/api/roundtable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "设计一个缓存层", rounds: 2 }),
    });
    const { events } = await collectSSE(response);
    const phases = events.filter((e) => e.event === "phase").map((e) => e.data.phase);
    expect(phases).toEqual(["answer", "debate", "synthesis"]);
    const deltas = events.filter((e) => e.event === "god-delta");
    const byGod = new Map<string, string>();
    for (const delta of deltas) {
      byGod.set(delta.data.god, (byGod.get(delta.data.god) ?? "") + delta.data.text);
    }
    expect(byGod.get("hermes")).toContain("hermes的第一轮回答");
    expect(byGod.get("athena")).toContain("雅典娜的结论");
    expect(byGod.get("hermes")).toContain("辩论轮：引用他人 -> saw peers");
    expect(byGod.get("athena")).toContain("辩论轮：引用他人 -> saw peers");
    const synthesis = events.find((e) => e.event === "done");
    expect(synthesis?.data.content).toContain("综合");

    // Isolation: each god's session file lives only in its own env.
    expect(listSessions(aRoot).length).toBeGreaterThan(0);
    expect(listSessions(bRoot).length).toBeGreaterThan(0);
  });

  it("errors for unknown gods surface as god-error events", async () => {
    const { server, url } = await listenPantheon(
      {
        gods: resolveGods(["hermes"], { id: "openai", displayName: "M", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "m" }, {}, HOME),
        workdir: HOME,
      },
      0,
    );
    servers.push(server);
    const response = await fetch(`${url}/api/solo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ god: "hermes", prompt: "hi" }),
    });
    const { events } = await collectSSE(response);
    expect(events.some((e) => e.event === "god-error")).toBe(true);
  });

  it("auto-creates the default roster when none exists", () => {
    const freshHome = mkdtempSync(path.join(tmpdir(), "pantheon-fresh-"));
    const gods = resolveGods([], { id: "deepseek", displayName: "D", baseUrl: "https://x/v1", apiKey: "k", model: "m" }, {}, freshHome);
    expect(gods.map((g) => g.name)).toEqual(["hermes", "athena", "hephaestus"]);
    for (const god of gods) {
      expect(existsSync(path.join(god.envRoot, "skills"))).toBe(true);
    }
    // Explicitly requested gods are created on demand.
    const withPoseidon = resolveGods(["poseidon"], { id: "deepseek", displayName: "D", baseUrl: "https://x/v1", apiKey: "k", model: "m" }, {}, freshHome);
    expect(withPoseidon.map((g) => g.name)).toContain("poseidon");
    // Missing gods are created on demand, even alongside existing ones.
    const partialHome = mkdtempSync(path.join(tmpdir(), "pantheon-partial-"));
    createEnv("athena", partialHome);
    const partialGods = resolveGods(["hermes"], { id: "deepseek", displayName: "D", baseUrl: "https://x/v1", apiKey: "k", model: "m" }, {}, partialHome);
    expect(existsSync(path.join(partialGods[0]?.envRoot ?? "", "skills"))).toBe(true);
  });
});

function existsSyncCheck(): boolean {
  return existsSync(path.join(HOME, "envs", "hermes"));
}
