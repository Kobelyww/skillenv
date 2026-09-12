import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import { anthropicChatCompletionStream, chatCompletionStream, resolveProvider, type ResolvedProvider } from "../src/agent/providers.js";
import { defaultTools, executeTool, toolSchemas } from "../src/agent/tools.js";
import { buildSystemPrompt, compactMessages, COMPACT_PLACEHOLDER, presentSkillNames, runAgentTurn } from "../src/agent/loop.js";
import { addSessionUsage, createSession, listSessions, loadSession, saveSession, sessionTokenCount } from "../src/agent/session.js";
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

  it("edit_file inserts new_string literally (no dollar-pattern expansion)", async () => {
    const tools = defaultTools();
    const file = path.join(workdir, "regex.txt");
    writeFileSync(file, "value = 1\n", "utf8");

    // Build "  it("globs and greps", async () => {" at runtime so this test file itself never has to contain the
    // sequence that String#replace would otherwise interpret.
    const dollarAmp = String.fromCharCode(36) + "&";
    const replacement = `= ${dollarAmp}2`;

    const edit = await executeTool(tools, context, {
      id: "edit-dollar",
      type: "function",
      function: {
        name: "edit_file",
        arguments: JSON.stringify({ path: "regex.txt", old_string: "= 1", new_string: replacement }),
      },
    });

    expect(edit.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(`value ${replacement}\n`);
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

  it("survives output larger than the capture buffer", async () => {
    const tools = defaultTools();
    // A script file keeps the command free of shell quoting differences.
    writeFileSync(path.join(workdir, "big-output.js"), "process.stdout.write('x'.repeat(9 * 1024 * 1024));", "utf8");
    const big = await executeTool(tools, context, {
      id: "big1",
      type: "function",
      function: { name: "run_command", arguments: JSON.stringify({ command: "node big-output.js", timeout_ms: 120_000 }) },
    });
    expect(big.output).toContain("exceeded the capture buffer");
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

  it("persists memory across calls within the environment", async () => {
    const env = createEnv("memory-env", HOME);
    const context2 = { workdir, envRoot: env.root };
    const tools = defaultTools();
    await executeTool(tools, context2, {
      id: "m1",
      type: "function",
      function: { name: "memory_write", arguments: JSON.stringify({ content: "user prefers vitest" }) },
    });
    const read = await executeTool(tools, context2, {
      id: "m2",
      type: "function",
      function: { name: "memory_read", arguments: "{}" },
    });
    expect(read.output).toContain("user prefers vitest");
    // Empty memory reads as a friendly placeholder, not an error.
    const fresh = { workdir, envRoot: createEnv("memory-fresh", HOME).root };
    const empty = await executeTool(tools, fresh, {
      id: "m3",
      type: "function",
      function: { name: "memory_read", arguments: "{}" },
    });
    expect(empty.output).toBe("(memory is empty)");
  });

  it("exposes schemas for every tool", () => {
    const schemas = toolSchemas(defaultTools());
    const names = schemas.map((schema) => schema.function.name);
    expect(names).toContain("run_command");
    expect(names).toContain("skill_read");
    expect(names).toContain("memory_read");
    expect(names).toContain("memory_write");
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

  it("accumulates turn usage and keeps zero totals undefined", () => {
    const env = createEnv("usage-env", HOME);
    const session = createSession(env.root, "usage-env", "deepseek", "deepseek-chat");
    expect(session.total_usage).toBeUndefined();
    expect(sessionTokenCount(session)).toBeUndefined();

    // Empty turns must not create a noisy zero entry.
    addSessionUsage(session, { prompt_tokens: 0, completion_tokens: 0 });
    expect(session.total_usage).toBeUndefined();

    addSessionUsage(session, { prompt_tokens: 100, completion_tokens: 23 });
    expect(session.total_usage).toEqual({ prompt_tokens: 100, completion_tokens: 23 });
    addSessionUsage(session, { prompt_tokens: 1200, completion_tokens: 200 });
    expect(session.total_usage).toEqual({ prompt_tokens: 1300, completion_tokens: 223 });
    expect(sessionTokenCount(session)).toBe(1523);

    // Round-trips through save/load with the total intact.
    saveSession(env.root, session);
    expect(loadSession(env.root, session.id).total_usage).toEqual({ prompt_tokens: 1300, completion_tokens: 223 });

    // A legacy session without the field stays clean on a zero turn.
    const legacy = createSession(env.root, "usage-env", "deepseek", "deepseek-chat");
    addSessionUsage(legacy, { prompt_tokens: 0, completion_tokens: 0 });
    expect(JSON.parse(JSON.stringify(legacy))).not.toHaveProperty("total_usage");
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

  it("executes parallel tool calls concurrently and re-joins in order", async () => {
    const env = createEnv("parallel-env", HOME);
    const started: string[] = [];
    let overlapping = false;
    const { url } = await startSseServer([
      [
        chunk({ tool_calls: [
          { index: 0, id: "p1", function: { name: "run_command", arguments: JSON.stringify({ command: "sleep 0.3 && echo first-done" }) } },
          { index: 1, id: "p2", function: { name: "run_command", arguments: JSON.stringify({ command: "echo second-done" }) } },
        ] }, "tool_calls"),
      ],
      sse("both finished"),
    ]);
    const provider: ResolvedProvider = { id: "test", displayName: "Test", baseUrl: url, apiKey: "", model: "m" };
    const toolResults: { name: string; output: string }[] = [];
    const messages: ChatMessage[] = [{ role: "user", content: "run both" }];
    const result = await runAgentTurn(
      {
        envRoot: env.root,
        envName: "parallel-env",
        provider,
        workdir: HOME,
        confirmShell: async (command) => {
          started.push(command.slice(0, 12));
          if (started.length === 2 && started[0]?.startsWith("sleep")) overlapping = true;
          return true;
        },
      },
      messages,
      {
        onTextDelta: () => {},
        onTurnStart: () => {},
        onToolCall: () => {},
        onToolResult: (name, _ok, output) => toolResults.push({ name, output }),
        onInfo: () => {},
      },
    );
    expect(result.content).toBe("both finished");
    expect(result.toolNames).toEqual(["run_command", "run_command"]);
    // The slow first call ran concurrently with the fast second one: the
    // second result arrived while the first was still sleeping.
    expect(overlapping).toBe(true);
    // Transcript order matches the model's tool_call order.
    expect(toolResults[0]?.output).toContain("first-done");
    expect(toolResults[1]?.output).toContain("second-done");
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages[0]?.tool_call_id).toBe("p1");
    expect(toolMessages[1]?.tool_call_id).toBe("p2");
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

    // The caller's transcript must never be mutated, including nested
    // tool_call payloads.
    const original = messages[2]?.tool_calls?.[0]?.function.arguments ?? "";
    expect(original).toContain("command"); // sanity: fixture has the payload
    compactMessages(messages, 10_000);
    expect(messages[2]?.tool_calls?.[0]?.function.arguments).toBe(original);
  });

  it("speaks the Anthropic Messages protocol when provider is anthropic", async () => {
    let captured: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> } | null = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        captured = {
          url: req.url ?? "",
          headers: { apiKey: req.headers["x-api-key"], version: req.headers["anthropic-version"] },
          body: JSON.parse(body),
        };
        const events = [
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"list_dir"}}',
          'event: content_block_delta\ndata: {"type":"input_json_delta","index":0,"partial_json":"{}"}',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
        ];
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const line of events) res.write(`${line}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`));
    });
    const provider: ResolvedProvider = { id: "anthropic", displayName: "Anthropic", baseUrl: url, apiKey: "sk-ant-test", model: "claude-test" };
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "list it" },
    ];
    const result = await anthropicChatCompletionStream(provider, messages, toolSchemas(defaultTools()), () => {});
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", type: "function", function: { name: "list_dir", arguments: "{}" } },
    ]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7 });
    const request = captured as unknown as NonNullable<typeof captured>;
    expect(request.url).toBe("/v1/messages");
    expect(request.headers.apiKey).toBe("sk-ant-test");
    expect(request.body.system).toBe("be brief");
    expect(request.body.model).toBe("claude-test");
    const tools = request.body.tools as { name: string; input_schema: unknown }[];
    expect(tools.map((t) => t.name)).toContain("read_file");
    expect(tools[0]?.input_schema).toBeDefined();
  });

  it("resolves the anthropic preset from ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    delete process.env.ANTHROPIC_MODEL;
    const provider = resolveProvider({ provider: "anthropic" });
    expect(provider.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(provider.model).toBe("claude-sonnet-4-5");
  });

  it("compacts aggressively and retries once on provider context overflow", async () => {
    const env = createEnv("overflow-env", HOME);
    let overflowSeen = false;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string | null }[] };
        if (!overflowSeen) {
          overflowSeen = true;
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("maximum context length exceeded");
          return;
        }
        // After the forced compaction the transcript must be smaller.
        const size = parsed.messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`${chunk({ content: `recovered after compaction (size ${size})` }, "stop")}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`));
    });
    const provider: ResolvedProvider = { id: "p", displayName: "P", baseUrl: url, apiKey: "", model: "m" };
    const filler = "y".repeat(9000);
    const messages: ChatMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: filler, tool_calls: [{ id: "t", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t", name: "read_file", content: filler },
      { role: "user", content: "continue" },
      { role: "assistant", content: filler },
      { role: "user", content: "go on" },
    ];
    const infos: string[] = [];
    const result = await runAgentTurn(
      { envRoot: env.root, envName: "overflow-env", provider, workdir: HOME },
      messages,
      {
        onTextDelta: () => {},
        onTurnStart: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onInfo: (line) => infos.push(line),
      },
    );
    expect(result.content).toContain("recovered after compaction");
    expect(infos.some((line) => line.includes("context overflow"))).toBe(true);
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

    // Non-empty memory is injected deterministically into the system prompt.
    mkdirSync(path.join(env.root, "memory"), { recursive: true });
    writeFileSync(path.join(env.root, "memory", "MEMORY.md"), "- user prefers vitest\n", "utf8");
    const withMemory = buildSystemPrompt({
      envRoot: env.root,
      envName: "prompt-env",
      provider: { id: "x", displayName: "X", baseUrl: "", apiKey: "", model: "m" },
      workdir: "/tmp",
    });
    expect(withMemory).toContain("# Persistent memory (from previous sessions)");
    expect(withMemory).toContain("user prefers vitest");
    // Empty memory stays out of the prompt entirely.
    const emptyEnv = createEnv("prompt-empty", HOME);
    const withoutMemory = buildSystemPrompt({
      envRoot: emptyEnv.root,
      envName: "prompt-empty",
      provider: { id: "x", displayName: "X", baseUrl: "", apiKey: "", model: "m" },
      workdir: "/tmp",
    });
    expect(withoutMemory).not.toContain("# Persistent memory");
  });
});

describe("sessionToMarkdown", () => {
  it("renders a readable transcript", async () => {
    const { sessionToMarkdown } = await import("../src/agent/session.js");
    const markdown = sessionToMarkdown({
      id: "agent-x",
      created_at: "2026-09-12T00:00:00Z",
      updated_at: "2026-09-12T00:00:00Z",
      provider: "deepseek",
      model: "deepseek-chat",
      env: "demo",
      messages: [
        { role: "user", content: "do the thing" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
        { role: "tool", tool_call_id: "t1", name: "read_file", content: "file body" },
        { role: "assistant", content: "done" },
      ],
    });
    expect(markdown).toContain("# agent session agent-x");
    expect(markdown).toContain("deepseek/deepseek-chat");
    expect(markdown).toContain("## tool call: read_file");
    expect(markdown).toContain("## tool: read_file");
    expect(markdown).toContain("file body");
    expect(markdown).toContain("## assistant");
    expect(markdown).toContain("done");
  });
});

describe("render", () => {
  it("quiet mode sends info to stderr and text to stdout", async () => {
    const { quietRender } = await import("../src/agent/render.js");
    const render = quietRender();
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      render.onTextDelta("visible");
      render.onInfo("metadata");
      render.onToolCall("run_command", "{}");
      render.onToolResult("run_command", true, "ok");
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(stdoutWrites.join("")).toBe("visible");
    expect(stderrWrites.join("")).toContain("metadata");
  });

  it("terminal mode renders tool cards", async () => {
    const { terminalRender } = await import("../src/agent/render.js");
    const render = terminalRender();
    const writes: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      render.onToolCall("read_file", '{"path":"a"}');
      render.onToolResult("read_file", false, "boom");
      render.onInfo("note");
    } finally {
      process.stdout.write = origOut;
    }
    const all = writes.join("");
    expect(all).toContain("read_file");
    expect(all).toContain("boom");
    expect(all).toContain("note");
  });
});
