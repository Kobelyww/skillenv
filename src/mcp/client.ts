import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defaultHome } from "../config.js";
import type { ToolContext2 } from "../agent/tools.js";

/**
 * MCP (Model Context Protocol) client — stdio transport, JSON-RPC 2.0.
 *
 * External tool servers are launched as subprocesses, their tools/list is
 * registered into the agent toolbox (namespaced `mcp__<server>__<tool>`),
 * and calls are forwarded over tools/call. A failing server is skipped with
 * a warning: degraded capability, never an outage.
 */

export const PROTOCOL_VERSION = "2024-11-05";

export class MCPError extends Error {}

export interface MCPServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpConnection {
  readonly name: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env: Record<string, string>;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail: string[] = [];
  serverInfo: Record<string, unknown> = {};

  constructor(spec: MCPServerSpec) {
    this.name = spec.name;
    this.command = spec.command;
    this.args = spec.args ?? [];
    this.env = spec.env ?? {};
  }

  async start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new MCPError(`failed to launch MCP server '${this.name}': ${(error as Error).message}`);
    }
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString());
      if (this.stderrTail.length > 20) this.stderrTail.shift();
    });
    child.on("error", (error) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new MCPError(`MCP server '${this.name}' crashed: ${error.message}`));
      }
      this.pending.clear();
    });

    const readline = createInterface({ input: child.stdout });
    readline.on("line", (line) => {
      const text = line.trim();
      if (text.length === 0) return;
      let message: { id?: number; error?: { message?: string }; result?: unknown };
      try {
        message = JSON.parse(text);
      } catch {
        return; // ignore malformed lines (server logs, banners)
      }
      const id = message.id;
      if (typeof id !== "number" || !this.pending.has(id)) return; // notification
      const pending = this.pending.get(id) as Pending;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new MCPError(`MCP error: ${message.error.message ?? "unknown"}`));
      } else {
        pending.resolve(message.result);
      }
    });

    const result = (await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "skillenv", version: "2.1.0" },
      },
      15_000,
    )) as { serverInfo?: Record<string, unknown> } | null;
    this.serverInfo = result?.serverInfo ?? {};
    this.notify("notifications/initialized");
  }

  private request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.child) throw new MCPError(`MCP server '${this.name}' is not running`);
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MCPError(`MCP ${method} timed out after ${timeoutMs}ms on '${this.name}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child?.stdin.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MCPError(`MCP server '${this.name}' stdin write failed: ${(error as Error).message}`));
      }
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
    } catch {
      // notifications are best-effort
    }
  }

  async listTools(): Promise<MCPToolSpec[]> {
    const result = (await this.request("tools/list")) as { tools?: MCPToolSpec[] } | null;
    return Array.isArray(result?.tools) ? (result?.tools as MCPToolSpec[]) : [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const result = (await this.request("tools/call", { name: toolName, arguments: args }, 60_000)) as {
      isError?: boolean;
      content?: { type?: string; text?: string }[];
    } | null;
    if (result?.isError) {
      const texts = (result.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "");
      throw new MCPError(texts.filter(Boolean).join("; ") || "tool reported an error");
    }
    const parts = (result?.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "");
    return parts.join("\n") || JSON.stringify(result ?? {});
  }

  /** Terminate the server process. Safe to call multiple times. */
  stop(): void {
    if (!this.child) return;
    try {
      this.child.kill();
    } catch {
      // already gone
    }
    this.child = null;
  }

  diagnostics(): string {
    return this.stderrTail.join("").slice(-500);
  }
}

/* ------------------------------------------------------------------ */
/* Config (~/.skillenv/mcp.json — Claude Code compatible shape)        */
/* ------------------------------------------------------------------ */

export function mcpConfigPath(home = defaultHome()): string {
  return path.join(home, "mcp.json");
}

export function loadMcpConfig(home = defaultHome()): MCPServerSpec[] {
  const file = mcpConfigPath(home);
  if (!existsSync(file)) return [];
  let data: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`MCP config is not valid JSON: ${file} (${(error as Error).message})`);
  }
  const servers = data.mcpServers ?? {};
  return Object.entries(servers).map(([name, spec]) => ({
    name,
    command: spec.command ?? "",
    args: Array.isArray(spec.args) ? spec.args : [],
    env: spec.env ?? {},
  }));
}

export function saveMcpConfig(specs: MCPServerSpec[], home = defaultHome()): void {
  const file = mcpConfigPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const spec of specs) {
    mcpServers[spec.name] = { command: spec.command, args: spec.args ?? [], env: spec.env ?? {} };
  }
  writeFileSync(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`, "utf8");
}

/* ------------------------------------------------------------------ */
/* Attach: launch servers, adapt tools into the agent toolbox          */
/* ------------------------------------------------------------------ */

export interface AttachedMcp {
  tools: ToolContext2[];
  connections: McpConnection[];
  attached: { server: string; tools: number }[];
  skipped: { server: string; error: string }[];
}

export async function attachMcpTools(specs: MCPServerSpec[]): Promise<AttachedMcp> {
  const tools: ToolContext2[] = [];
  const connections: McpConnection[] = [];
  const attached: { server: string; tools: number }[] = [];
  const skipped: { server: string; error: string }[] = [];

  for (const spec of specs) {
    const connection = new McpConnection(spec);
    try {
      await connection.start();
      const remote = await connection.listTools();
      for (const toolSpec of remote) {
        if (typeof toolSpec?.name !== "string" || toolSpec.name.length === 0) continue;
        tools.push({
          name: `mcp__${spec.name}__${toolSpec.name}`,
          description: `[MCP:${spec.name}] ${toolSpec.description ?? toolSpec.name}`,
          parameters:
            toolSpec.inputSchema && typeof toolSpec.inputSchema === "object"
              ? toolSpec.inputSchema
              : { type: "object", properties: {}, required: [] },
          execute: async (args) => {
            try {
              return { ok: true, output: await connection.callTool(toolSpec.name, args) };
            } catch (error) {
              return { ok: false, output: `MCP tool failed: ${(error as Error).message}` };
            }
          },
        });
      }
      connections.push(connection);
      attached.push({ server: spec.name, tools: remote.length });
    } catch (error) {
      connection.stop();
      skipped.push({ server: spec.name, error: (error as Error).message.slice(0, 200) });
    }
  }
  return { tools, connections, attached, skipped };
}
