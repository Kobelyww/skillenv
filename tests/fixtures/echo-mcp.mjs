// Minimal MCP stdio server: initialize + tools/list + tools/call(echo, add).
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  if (typeof msg.id !== "number") return;
  let result = {};
  if (msg.method === "initialize") {
    result = { protocolVersion: "2024-11-05", serverInfo: { name: "echo-server", version: "1.0.0" } };
  } else if (msg.method === "tools/list") {
    result = {
      tools: [
        { name: "echo", description: "Echo back the input text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
      ],
    };
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") result = { content: [{ type: "text", text: `echo: ${args.text}` }] };
    else if (name === "add") result = { content: [{ type: "text", text: `sum: ${args.a + args.b}` }] };
    else result = { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
});
