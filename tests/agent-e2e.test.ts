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
let providerUrl = "";
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
});

const CHILD_ENV = {
  ...process.env,
  SKILLENV_HOME: "",
  SKILLENV_AGENT_PROVIDER: "openai",
  OPENAI_API_KEY: "test-key",
  OPENAI_BASE_URL: "",
  OPENAI_MODEL: "mock-model",
};

function agent(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "dist", "cli.js"), "agent", "agent-e2e", ...args], {
      cwd: projectDir,
      env: { ...CHILD_ENV, SKILLENV_HOME: HOME, OPENAI_BASE_URL: providerUrl },
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

  it("streams errors clearly when the provider is unreachable", async () => {
    const result = await agent(["-q", "hi", "--base-url", "http://127.0.0.1:9/v1"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error:");
  });
});
