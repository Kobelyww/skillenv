import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
let HOME = "";
let projectDir = "";
let server: http.Server;
let anthropicServerRef: http.Server | null = null;
const servers: http.Server[] = [];
let providerUrl = "";
let anthropicUrl = "";
let requestsSeen = 0;

function sseChunk(delta: Record<string, unknown>, finish?: string): string {
  const choice: Record<string, unknown> = { delta };
  if (finish) choice.finish_reason = finish;
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

beforeAll(async () => {
  HOME = mkdtempSync(path.join(tmpdir(), "agent-e2e-home-"));
  projectDir = mkdtempSync(path.join(tmpdir(), "agent-e2e-proj-"));
  writeFileSync(path.join(projectDir, "README.md"), "# demo\n\nA tiny project.\n", "utf8");

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestsSeen += 1;
      const parsed = JSON.parse(body) as { messages: { role: string; content: string | null }[] };
      const last = parsed.messages.at(-1);
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (requestsSeen % 2 === 1) {
        res.write(
          sseChunk(
            {
              tool_calls: [
                { index: 0, id: "call-read", function: { name: "read_file", arguments: JSON.stringify({ path: "README.md" }) } },
              ],
            },
            "tool_calls",
          ),
        );
      } else {
        const toolResult = last?.role === "tool" ? String(last.content) : "";
        res.write(sseChunk({ content: `The README says: ${toolResult.slice(0, 40)}` }, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });

  // Anthropic-protocol mock for the provider-dispatch e2e test.
  const anthropicServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { role: string; content: unknown }[] };
      const sawToolResult = parsed.messages.some(
        (m) => m.role === "user" && Array.isArray(m.content) &&
          (m.content as { type?: string }[]).some((b) => b.type === "tool_result"),
      );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!sawToolResult) {
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "input_json_delta", index: 0, partial_json: JSON.stringify({ path: "README.md" }) })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}\n\n`,
        );
      } else {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The README says: demo" } })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
        );
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => {
    anthropicServer.listen(0, "127.0.0.1", () => {
      const address = anthropicServer.address() as { port: number };
      anthropicUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    });
  });
  anthropicServerRef = anthropicServer;

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      providerUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    });
  });

  spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "create", "agent-e2e"], {
    env: { ...process.env, SKILLENV_HOME: HOME },
    encoding: "utf8",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (anthropicServerRef) {
    await new Promise<void>((resolve) => anthropicServerRef.close(() => resolve()));
  }
});

const CHILD_ENV = {
  ...process.env,
  SKILLENV_HOME: "",
  SKILLENV_AGENT_PROVIDER: "openai",
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "",
  OPENAI_MODEL: "mock-model",
};

function agent(
  args: string[],
  timeoutMs = 30_000,
  providerEnv: Record<string, string> = {},
  envName = "agent-e2e",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "dist", "cli.js"), "agent", envName, ...args], {
      cwd: projectDir,
      env: { ...CHILD_ENV, SKILLENV_HOME: HOME, OPENAI_BASE_URL: providerUrl, ...providerEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent child timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function cliSync(args: string[]): { status: number; stdout: string } {
  const result = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), ...args], {
    env: { ...process.env, SKILLENV_HOME: HOME },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

describe("agent end-to-end through the CLI", () => {
  it("completes a one-shot tool loop against an OpenAI-compatible server", async () => {
    const result = await agent(["-q", "Summarize the README."]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The README says:");
    expect(result.stderr).toContain("mock-model");
  });

  it("persists a resumable session", async () => {
    const result = await agent(["-q", "Summarize the README again."]);
    expect(result.code).toBe(0);

    const list = cliSync(["session", "list", "agent-e2e"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("openai/mock-model");

    const sessionsDir = path.join(HOME, "envs", "agent-e2e", "sessions");
    expect(existsSync(sessionsDir)).toBe(true);
    const files = readdirSync(sessionsDir).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    // Sessions within the same second share a timestamp prefix, so scan all
    // transcripts instead of relying on filename order.
    const transcripts = files.map((file) =>
      readFileSync(path.join(sessionsDir, file), "utf8"),
    );
    expect(transcripts.some((text) => text.includes("read_file"))).toBe(true);
    expect(transcripts.some((text) => text.includes("Summarize the README again."))).toBe(true);
    expect(transcripts.some((text) => text.includes("Summarize the README."))).toBe(true);
  });

  it("drives the full loop over the Anthropic Messages protocol", async () => {
    const result = await agent(
      ["-p", "anthropic", "-q", "Summarize the README."],
      30_000,
      { SKILLENV_AGENT_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: anthropicUrl, ANTHROPIC_MODEL: "mock-claude" },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("The README says:");
    expect(result.stderr).toContain("Anthropic");
    expect(result.stderr).toContain("mock-claude");
  });

  it("fails fast when --dir does not exist", async () => {
    const result = await agent(["-q", "hi", "--dir", "/nonexistent/dir/xyz"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("workdir does not exist");
  });

  it("two agent harnesses coordinate over the mailbox", { timeout: 180_000 }, async () => {
    // Deterministic scripted provider: write result -> agent_send -> summary,
    // then for the peer: inbox read -> reply -> summary.
    const _mk1 = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "create", "mail-worker"], {
      env: { ...process.env, SKILLENV_HOME: HOME },
      encoding: "utf8",
    });

    const _mk2 = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), "create", "mail-peer"], {
      env: { ...process.env, SKILLENV_HOME: HOME },
      encoding: "utf8",
    });


    // Simpler: two servers with the branch logic distinguished by a flag.
    const makeServer = (isWorker: boolean): Promise<string> =>
      new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            const parsed = JSON.parse(body) as { messages: { role: string; content: string | null; tool_calls?: { function: { name: string } }[] }[] };
            const last = parsed.messages.at(-1);
            const lastTool = last?.role === "tool" ? last.name : undefined;
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            const toolCall = (id: string, name: string, args: unknown) =>
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\n`;
            const text = (t: string) =>
              `data: ${JSON.stringify({ choices: [{ delta: { content: t }, finish_reason: "stop" }] })}\n\n`;
            if (isWorker) {
              if (last?.role === "user") {
                res.write(toolCall("w1", "write_file", { path: "result.txt", content: "analysis complete" }));
              } else if (lastTool === "write_file") {
                res.write(toolCall("w2", "agent_send", { to: "mail-peer", message: "result.txt ready; content: analysis complete" }));
              } else {
                res.write(text("Handed off to mail-peer."));
              }
            } else {
              if (last?.role === "user") {
                res.write(toolCall("p1", "agent_inbox", {}));
              } else if (lastTool === "agent_inbox") {
                res.write(toolCall("p2", "agent_send", { to: "mail-worker", message: "acknowledged: result.txt" }));
              } else {
                res.write(text("Acknowledged: result.txt"));
              }
            }
            res.end("data: [DONE]\n\n");
          });
        });
        srv.listen(0, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`);
        });
        servers.push(srv);
      });

    const workerUrl = await makeServer(true);
    const peerUrl = await makeServer(false);

    // Turn 1: worker writes and hands off.
    const send = await agent(
      ["--peers", "mail-peer", "-q", "Do the handoff."],
      60_000,
      { SKILLENV_AGENT_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_BASE_URL: workerUrl, OPENAI_MODEL: "mock-worker" },
      "mail-worker",
    );
    expect(send.code).toBe(0);

    // The peer mailbox holds the worker's message.
    const peerMail = path.join(HOME, "envs", "mail-peer", "mailbox");
    expect(existsSync(peerMail)).toBe(true);
    const files = readdirSync(peerMail).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const message = JSON.parse(readFileSync(path.join(peerMail, files[0] as string), "utf8"));
    expect(message.from).toBe("mail-worker");
    expect(message.body).toContain("result.txt");

    // Turn 2: peer reads its inbox and replies over the bus.
    const reply = await agent(
      ["--peers", "mail-worker", "-q", "Check your inbox and reply."],
      60_000,
      { SKILLENV_AGENT_PROVIDER: "openai", OPENAI_API_KEY: "k", OPENAI_BASE_URL: peerUrl, OPENAI_MODEL: "mock-peer" },
      "mail-peer",
    );
    expect(reply.code).toBe(0);

    // The worker's mailbox now holds the peer's acknowledgement.
    const workerMail = path.join(HOME, "envs", "mail-worker", "mailbox");
    expect(existsSync(workerMail)).toBe(true);
    const workerFiles = readdirSync(workerMail).filter((f) => f.endsWith(".json"));
    const bodies = workerFiles.map((f) => readFileSync(path.join(workerMail, f), "utf8"));
    expect(bodies.some((text) => text.includes("acknowledged"))).toBe(true);
    expect(bodies.every((text) => JSON.parse(text).from === "mail-peer")).toBe(true);
  });

  it("streams errors clearly when the provider is unreachable", async () => {
    const result = await agent(["-q", "hi", "--base-url", "http://127.0.0.1:9/v1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
  });
});
