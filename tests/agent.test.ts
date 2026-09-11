import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { chatCompletionStream, resolveProvider, type ResolvedProvider } from "../src/agent/providers.js";
import { defaultTools, executeTool, toolSchemas } from "../src/agent/tools.js";
import { buildSystemPrompt, presentSkillNames, runAgentTurn } from "../src/agent/loop.js";
import { createSession, listSessions, loadSession, saveSession } from "../src/agent/session.js";
import { createEnv } from "../src/env.js";
import { makeSkill } from "./helpers.js";

const HOME = mkdtempSync(path.join(tmpdir(), "agent-"));
const servers: http.Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
  rmSync(HOME, { recursive: true, force: true });
});

function startSseServer(
  responses: object[],
  options: { status?: number } = {},
): Promise<{ url: string; requests: unknown[] }> {
  let index = 0;
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      if (options.status) {
        res.writeHead(options.status, { "Content-Type": "text/plain" });
        res.end("provider exploded");
        return;
      }
      const response = responses[Math.min(index, responses.length - 1)] as object;
      index += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const line of response as unknown as string[]) {
        res.write(`${line}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${address.port}/v1`, requests });
    });
  });
}

function chunk(delta: Record<string, unknown>, finish?: string): string {
  const choice: Record<string, unknown> = { delta };
  if (finish) choice.finish_reason = finish;
  return `data: ${JSON.stringify({ choices: [choice] })}`;
}

function sse(content?: string, tool?: { id: string; name: string; args: string }): string[] {
  if (tool) {
    const call: Record<string, unknown> = { index: 0, id: tool.id, function: { name: tool.name, arguments: tool.args } };
    return [chunk({ tool_calls: [call] }, "tool_calls")];
  }
  return [chunk(content ? { content } : {}, "stop")];
}

describe("resolveProvider", () => {
  it("resolves deepseek from env", () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    delete process.env.DEEPSEEK_MODEL;
    const provider = resolveProvider({ provider: "deepseek" });
    expect(provider.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(provider.model).toBe("deepseek-chat");
  });

  it("honors model and base url overrides", () => {
    process.env.DEEPSEEK_API_KEY = "k";
    const provider = resolveProvider({ provider: "deepseek", model: "deepseek-reasoner", baseUrl: "http://proxy:9000/v1" });
    expect(provider.model).toBe("deepseek-reasoner");
    expect(provider.baseUrl).toBe("http://proxy:9000/v1");
  });

  it("fails without an api key", () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => resolveProvider({ provider: "deepseek" })).toThrow("DEEPSEEK_API_KEY");
    if (previous) process.env.DEEPSEEK_API_KEY = previous;
  });

  it("fails for unknown providers", () => {
    expect(() => resolveProvider({ provider: "nope" })).toThrow("unknown provider: nope");
  });

  it("ollama needs no key", () => {
    const provider = resolveProvider({ provider: "ollama", model: "llama3" });
    expect(provider.id).toBe("ollama");
    expect(provider.apiKey).toBe("");
  });
});

describe("chatCompletionStream", () => {
  it("parses SSE content and usage", async () => {
    const { url } = await startSseServer([
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}`,
      ],
    ]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    let text = "";
    const result = await chatCompletionStream(provider, [{ role: "user", content: "hi" }], [], (delta) => {
      text += delta;
    });
    expect(text).toBe("Hello");
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.prompt_tokens).toBe(5);
  });

  it("accumulates streamed tool-call fragments", async () => {
    const { url } = await startSseServer([
      [
        chunk({ tool_calls: [{ index: 0, id: "call1", function: { name: "list", arguments: '{"pa' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'th": "."}' } }] }),
        chunk({}, "tool_calls"),
      ],
    ]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    const result = await chatCompletionStream(provider, [{ role: "user", content: "hi" }], [], () => {});
    expect(result.toolCalls).toEqual([
      { id: "call1", type: "function", function: { name: "list", arguments: '{"path": "."}' } },
    ]);
  });

  it("surfaces http errors", async () => {
    const { url } = await startSseServer([], { status: 500 });
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    await expect(chatCompletionStream(provider, [{ role: "user", content: "hi" }], [], () => {})).rejects.toThrow(
      /HTTP 500/,
    );
  });
});

describe("tools", () => {
  const workdir = mkdtempSync(path.join(tmpdir(), "tools-"));
  const context = { workdir, envRoot: workdir };

  it("writes, reads, and edits files", async () => {
    const tools = defaultTools();
    const write = await executeTool(tools, context, {
      id: "1",
      type: "function",
      function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.txt", content: "alpha\nbeta\n" }) },
    });
    expect(write.ok).toBe(true);

    const read = await executeTool(tools, context, {
      id: "2",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "src/a.txt" }) },
    });
    expect(read.output).toContain("1\talpha");

    const edit = await executeTool(tools, context, {
      id: "3",
      type: "function",
      function: {
        name: "edit_file",
        arguments: JSON.stringify({ path: "src/a.txt", old_string: "beta", new_string: "gamma" }),
      },
    });
    expect(edit.ok).toBe(true);
    expect(readFileSync(path.join(workdir, "src", "a.txt"), "utf8")).toContain("gamma");

    const ambiguous = await executeTool(tools, context, {
      id: "4",
      type: "function",
      function: {
        name: "edit_file",
        arguments: JSON.stringify({ path: "src/a.txt", old_string: "a", new_string: "z" }),
      },
    });
    expect(ambiguous.ok).toBe(false);
  });

  it("globs and greps", async () => {
    const tools = defaultTools();
    const glob = await executeTool(tools, context, {
      id: "5",
      type: "function",
      function: { name: "glob", arguments: JSON.stringify({ pattern: "src/**/*.txt" }) },
    });
    expect(glob.output).toContain("src/a.txt");

    const grep = await executeTool(tools, context, {
      id: "6",
      type: "function",
      function: { name: "grep", arguments: JSON.stringify({ pattern: "gamma", path: "src" }) },
    });
    expect(grep.output).toContain("gamma");
  });

  it("runs shell commands with exit codes", async () => {
    const tools = defaultTools();
    const ok = await executeTool(tools, context, {
      id: "7",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: "echo hello" }) },
    });
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain("hello");

    const failing = await executeTool(tools, context, {
      id: "8",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: "exit 3" }) },
    });
    expect(failing.ok).toBe(false);
    expect(failing.output).toContain("exit code: 3");
  });

  it("blocks private addresses in web_fetch", async () => {
    const tools = defaultTools();
    const result = await executeTool(tools, context, {
      id: "9",
      type: "function",
      function: { name: "web_fetch", arguments: JSON.stringify({ url: "http://127.0.0.1:1/x" }) },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("blocked");
  });

  it("lists and reads environment skills", async () => {
    const env = createEnv("skill-tools", HOME);
    makeSkill(path.join(env.root, "skills"), "pdf-skill", { description: "Work with PDFs" });
    const context2 = { workdir, envRoot: env.root };
    const tools = defaultTools();
    const list = await executeTool(tools, context2, {
      id: "10",
      type: "function",
      function: { name: "skill_list", arguments: "{}" },
    });
    expect(list.output).toContain("pdf-skill: Work with PDFs");

    const read = await executeTool(tools, context2, {
      id: "11",
      type: "function",
      function: { name: "skill_read", arguments: JSON.stringify({ name: "pdf-skill" }) },
    });
    expect(read.output).toContain("# pdf-skill");

    const traversal = await executeTool(tools, context2, {
      id: "12",
      type: "function",
      function: { name: "skill_read", arguments: JSON.stringify({ name: "../../etc" }) },
    });
    expect(traversal.ok).toBe(false);
  });

  it("exposes schemas for every tool", () => {
    const schemas = toolSchemas(defaultTools());
    const names = schemas.map((schema) => schema.function.name);
    expect(names).toContain("run_command");
    expect(names).toContain("skill_read");
    for (const schema of schemas) {
      expect(schema.function.parameters.type).toBe("object");
    }
  });
});

describe("sessions", () => {
  it("create, save, list, load", () => {
    const env = createEnv("sessions-env", HOME);
    const session = createSession(env.root, "sessions-env", "deepseek", "deepseek-chat");
    session.messages.push({ role: "user", content: "hello" });
    saveSession(env.root, session);

    const loaded = loadSession(env.root, session.id);
    expect(loaded.messages[0]?.content).toBe("hello");
    expect(listSessions(env.root).map((s) => s.id)).toContain(session.id);

    expect(() => loadSession(env.root, "missing")).toThrow("session not found");
  });
});

describe("agent loop", () => {
  it("runs tool calls then produces a final answer", async () => {
    const env = createEnv("loop-env", HOME);
    const { url, requests } = await startSseServer([
      sse(undefined, { id: "t1", name: "list_dir", args: "{}" }),
      sse("Directory is empty."),
    ]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    const messages = [{ role: "user" as const, content: "what is in the directory?" }];
    const result = await runAgentTurn(
      { envRoot: env.root, envName: "loop-env", provider, workdir: HOME },
      messages,
      { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
    );
    expect(result.content).toBe("Directory is empty.");
    expect(result.toolCalls).toBe(1);
    expect(result.iterations).toBe(2);
    // System prompt injected + user + assistant + tool result + assistant
    expect(messages.length).toBe(5);
    expect((messages[0]?.content as string)).toContain("skillenv agent");
    const followUp = requests[1] as { messages: { role: string }[] };
    expect(followUp.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("builds a system prompt with skill inventory", () => {
    const env = createEnv("prompt-env", HOME);
    makeSkill(path.join(env.root, "skills"), "latex", { description: "Typeset documents" });
    const prompt = buildSystemPrompt({
      envRoot: env.root,
      envName: "prompt-env",
      provider: { id: "x", displayName: "X", baseUrl: "", apiKey: "", model: "m" },
      workdir: "/tmp",
      inlineSkills: ["latex"],
    });
    expect(prompt).toContain("skillenv agent");
    expect(prompt).toContain("# Inlined skills");
    expect(prompt).toContain("Typeset documents");
    expect(presentSkillNames(env.root)).toEqual(["latex"]);
  });
});
