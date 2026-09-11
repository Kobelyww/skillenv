import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { chatCompletionStream, resolveProvider, type ResolvedProvider } from "../src/agent/providers.js";
import { defaultTools, executeTool, toolSchemas } from "../src/agent/tools.js";
import { buildSystemPrompt, compactMessages, COMPACT_PLACEHOLDER, presentSkillNames, runAgentTurn } from "../src/agent/loop.js";
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

  it("degrades gracefully at the iteration limit with a tool-less summary", async () => {    const env = createEnv("limit-env", HOME);
    // Smart mock: requests carrying `tools` get a tool call; the summary
    // request (no tools) gets the final content.
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { tools?: unknown };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (parsed.tools) {
          res.write(`${chunk({ tool_calls: [{ index: 0, id: "t", function: { name: "list_dir", arguments: "{}" } }] }, "tool_calls")}\n\n`);
        } else {
          res.write(`${chunk({ content: "Wrapped up: nothing left to do." }, "stop")}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
      });
    });
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    const messages = [{ role: "user" as const, content: "keep going" }];
    const infos: string[] = [];
    const result = await runAgentTurn(
      { envRoot: env.root, envName: "limit-env", provider, workdir: HOME, maxIterations: 2 },
      messages,
      {
        onTextDelta: () => {},
        onTurnStart: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onInfo: (line) => infos.push(line),
      },
    );
    expect(infos.some((line) => line.includes("max iterations (2)"))).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.content).toBe("Wrapped up: nothing left to do.");
    expect(messages.at(-1)?.content).toBe("Wrapped up: nothing left to do.");
  });

  it("fails over to the fallback provider when the primary fails before output", async () => {
    const env = createEnv("failover-env", HOME);
    // Primary: always 500. Fallback: normal tool-call + final answer exchange.
    const primary = await startSseServer([], { status: 500 });
    const { url: fallbackUrl, requests } = await startSseServer([
      sse(undefined, { id: "t1", name: "list_dir", args: "{}" }),
      sse("Answer via fallback."),
    ]);
    const infos: string[] = [];
    const result = await runAgentTurn(
      {
        envRoot: env.root,
        envName: "failover-env",
        provider: { id: "primary", displayName: "Primary", baseUrl: primary.url, apiKey: "", model: "m" },
        fallbackProvider: { id: "backup", displayName: "Backup", baseUrl: fallbackUrl, apiKey: "", model: "fb" },
        workdir: HOME,
      },
      [{ role: "user", content: "hi" }],
      {
        onTextDelta: () => {},
        onTurnStart: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onInfo: (line) => infos.push(line),
      },
    );
    expect(result.content).toBe("Answer via fallback.");
    expect(infos.some((line) => line.includes("failing over to 'backup'"))).toBe(true);
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it("restricts the toolbox via the tools allowlist", async () => {
    const env = createEnv("tools-env", HOME);
    const { url, requests } = await startSseServer([sse("ok")]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    await runAgentTurn(
      { envRoot: env.root, envName: "tools-env", provider, workdir: HOME, tools: ["read_file", "grep"] },
      [{ role: "user", content: "hi" }],
      { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
    );
    const first = requests[0] as { tools?: { function: { name: string } }[] };
    const names = (first.tools ?? []).map((t) => t.function.name);
    expect(names).toEqual(["read_file", "grep"]);
  });

  it("compacts oversized conversations while preserving pairing", async () => {
    const filler = "x".repeat(6000);
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first request" },
      { role: "assistant", content: filler, tool_calls: [{ id: "call-1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: filler }) } }] },
      { role: "tool", tool_call_id: "call-1", name: "run_command", content: filler },
      { role: "user", content: "second request" },
      { role: "assistant", content: "short answer" },
    ];
    const { messages: out, compacted } = compactMessages(messages, 10_000);
    expect(compacted).toBe(true);
    const total = out.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    expect(total).toBeLessThan(10_000);
    // Structure intact: pairing ids preserved, first user and tail verbatim.
    expect(out[1]?.content).toBe("first request");
    expect(out[2]?.tool_calls?.[0]?.id).toBe("call-1");
    expect(out[3]?.tool_call_id).toBe("call-1");
    expect(out.at(-1)?.content).toBe("short answer");
    expect(out.some((m) => m.content?.includes(COMPACT_PLACEHOLDER))).toBe(true);

    // Small conversations pass through untouched.
    const small = compactMessages([{ role: "user", content: "hi" }], 20_000);
    expect(small.compacted).toBe(false);
    expect(small.messages[0]?.content).toBe("hi");

    // Budget disabled.
    const disabled = compactMessages(messages, 0);
    expect(disabled.compacted).toBe(false);
  });

  it("retries transient 5xx with backoff before succeeding", async () => {
    const env = createEnv("retry-env", HOME);
    // A server that fails twice with 503 then answers correctly.
    let failures = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (failures < 2) {
          failures += 1;
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("overloaded");
          return;
        }
        JSON.parse(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`${chunk({ content: "recovered" }, "stop")}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`));
    });
    const infos: string[] = [];
    const result = await runAgentTurn(
      { envRoot: env.root, envName: "retry-env", provider: { id: "p", displayName: "P", baseUrl: url, apiKey: "", model: "m" }, workdir: HOME },
      [{ role: "user", content: "hi" }],
      { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: (line) => infos.push(line) },
    );
    expect(result.content).toBe("recovered");
    expect(infos.some((line) => line.includes("attempt 1 failed") && line.includes("retrying in 500ms"))).toBe(true);
  }, 15000);

  it("does not retry non-retryable 4xx errors", async () => {
    const env = createEnv("no4xx-env", HOME);
    const { url, requests } = await startSseServer([], { status: 400 });
    await expect(
      runAgentTurn(
        { envRoot: env.root, envName: "no4xx-env", provider: { id: "p", displayName: "P", baseUrl: url, apiKey: "", model: "m" }, workdir: HOME },
        [{ role: "user", content: "hi" }],
        { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
      ),
    ).rejects.toThrow(/HTTP 400/);
    expect(requests.length).toBe(1);
  });

  it("honors confirmShell for run_command (decline and approve)", async () => {
    const env = createEnv("confirm-env", HOME);
    const answers: boolean[] = [false, true];
    let turnIndex = -1;
    const { url } = await startSseServer([
      sse(undefined, { id: "t1", name: "run_command", args: JSON.stringify({ command: "echo hi" }) }),
      sse(undefined, { id: "t2", name: "run_command", args: JSON.stringify({ command: "echo again" }) }),
      sse("Done with both."),
    ]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    const toolResults: { ok: boolean; output: string }[] = [];
    const result = await runAgentTurn(
      {
        envRoot: env.root,
        envName: "confirm-env",
        provider,
        workdir: HOME,
        confirmShell: async () => answers[++turnIndex] ?? false,
      },
      [{ role: "user", content: "run two commands" }],
      {
        onTextDelta: () => {},
        onTurnStart: () => {},
        onToolCall: () => {},
        onToolResult: (_name, ok, output) => toolResults.push({ ok, output }),
        onInfo: () => {},
      },
    );
    expect(result.content).toBe("Done with both.");
    expect(result.toolCalls).toBe(2);
    expect(toolResults[0]?.ok).toBe(false);
    expect(toolResults[0]?.output).toContain("declined");
    expect(toolResults[1]?.ok).toBe(true);
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
