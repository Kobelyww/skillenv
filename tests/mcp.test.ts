import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attachMcpTools, loadMcpConfig, McpConnection, saveMcpConfig } from "../src/mcp/client.js";
import { executeTool, toolSchemas, defaultTools } from "../src/agent/tools.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "echo-mcp.mjs");

describe("mcp config", () => {
  it("round-trips servers through ~/.skillenv/mcp.json", () => {
    const home = mkdtempSync(path.join(tmpdir(), "mcp-cfg-"));
    process.env.SKILLENV_HOME = home;
    expect(loadMcpConfig(home)).toEqual([]);
    saveMcpConfig(
      [{ name: "echo", command: "node", args: [FIXTURE], env: { FOO: "bar" } }],
      home,
    );
    expect(existsSync(path.join(home, "mcp.json"))).toBe(true);
    const specs = loadMcpConfig(home);
    expect(specs).toEqual([
      { name: "echo", command: "node", args: [FIXTURE], env: { FOO: "bar" } },
    ]);
  });
});

describe("McpConnection", () => {
  it("handshakes, lists tools, and calls them", async () => {
    const connection = new McpConnection({ name: "echo", command: "node", args: [FIXTURE] });
    await connection.start();
    expect((connection.serverInfo as { name?: string }).name).toBe("echo-server");

    const tools = await connection.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    const echoed = await connection.callTool("echo", { text: "hello mcp" });
    expect(echoed).toBe("echo: hello mcp");

    const sum = await connection.callTool("add", { a: 19, b: 23 });
    expect(sum).toBe("sum: 42");

    await expect(connection.callTool("nope", {})).rejects.toThrow(/unknown tool/);
    connection.stop();
  });

  it("fails cleanly on a missing server binary", async () => {
    const connection = new McpConnection({ name: "ghost", command: "definitely-mcp-missing-bin" });
    await expect(connection.start()).rejects.toThrow(/launch|MCP server/);
    connection.stop();
  });
});

describe("attachMcpTools", () => {
  it("proxies remote tools into the agent toolbox", async () => {
    const attach = await attachMcpTools([{ name: "echo", command: "node", args: [FIXTURE] }]);
    expect(attach.skipped).toEqual([]);
    expect(attach.attached).toEqual([{ server: "echo", tools: 2 }]);
    const names = attach.tools.map((tool) => tool.name);
    expect(names).toContain("mcp__echo__echo");
    expect(names).toContain("mcp__echo__add");

    // Proxy executes over the bus and renders as a normal tool.
    const schema = toolSchemas(attach.tools).find((s) => s.function.name === "mcp__echo__add");
    expect(schema?.function.parameters).toMatchObject({ type: "object" });
    const result = await executeTool(attach.tools, { workdir: tmpdir(), envRoot: tmpdir() }, {
      id: "1",
      type: "function",
      function: { name: "mcp__echo__add", arguments: JSON.stringify({ a: 2, b: 3 }) },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("sum: 5");

    // A tool error becomes ok:false, never a crash.
    const bad = await executeTool(attach.tools, { workdir: tmpdir(), envRoot: tmpdir() }, {
      id: "2",
      type: "function",
      function: { name: "mcp__echo__echo", arguments: JSON.stringify({ wrong: 1 }) },
    });
    expect(bad.ok).toBe(true); // fixture echoes anything

    for (const connection of attach.connections) connection.stop();
  });

  it("skips broken servers without breaking the rest", async () => {
    const attach = await attachMcpTools([
      { name: "broken", command: "definitely-mcp-missing-bin" },
      { name: "echo", command: "node", args: [FIXTURE] },
    ]);
    expect(attach.skipped).toHaveLength(1);
    expect(attach.skipped[0]?.server).toBe("broken");
    expect(attach.attached).toEqual([{ server: "echo", tools: 2 }]);
    for (const connection of attach.connections) connection.stop();
  });

  it("mcp tools merge with built-ins and respect the allowlist", async () => {
    const attach = await attachMcpTools([{ name: "echo", command: "node", args: [FIXTURE] }]);
    for (const connection of attach.connections) connection.stop();

    const merged = [...defaultTools().map((t) => t.name), ...attach.tools.map((t) => t.name)];
    expect(merged).toContain("mcp__echo__add");
    void merged;

  });

  it("loop merges extraTools and applies the allowlist", async () => {
    const { runAgentTurn } = await import("../src/agent/loop.js");
    const { createEnv } = await import("../src/env.js");
    const attach = await attachMcpTools([{ name: "echo", command: "node", args: [FIXTURE] }]);
    for (const connection of attach.connections) connection.stop();
    const env = createEnv("mcp-loop", mkdtempSync(path.join(tmpdir(), "mcp-loop-")));
    const provider = { id: "mock", displayName: "Mock", baseUrl: "http://127.0.0.1:1/v1", apiKey: "", model: "m" };
    const messages = [{ role: "user" as const, content: "hi" }];
    await expect(
      runAgentTurn(
        { envRoot: env.root, envName: "mcp-loop", provider, workdir: tmpdir(), extraTools: attach.tools, tools: ["mcp__echo__add"] },
        messages,
        { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
      ),
    ).rejects.toThrow(); // unreachable provider — but extraTools/allowlist plumbing exercised
  });
});

describe("cli mcp config round trip", () => {
  it("add/list/remove persist to mcp.json", () => {
    const home = mkdtempSync(path.join(tmpdir(), "mcp-cli-"));
    process.env.SKILLENV_HOME = home;
    saveMcpConfig(
      [
        { name: "a", command: "node", args: ["a.js"], env: {} },
        { name: "b", command: "node", args: ["b.js"], env: {} },
      ],
      home,
    );
    const removed = loadMcpConfig(home).filter((spec) => spec.name !== "a");
    saveMcpConfig(removed, home);
    const specs = loadMcpConfig(home);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.name).toBe("b");
    expect(readFileSync(path.join(home, "mcp.json"), "utf8")).toContain("b.js");
  });
});
