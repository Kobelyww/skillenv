import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEnv } from "../src/env.js";
import { loadEvalSuite, runEvalSuite, type EvalSuite } from "../src/agent/eval.js";
import { chatCompletionStream } from "../src/agent/providers.js";
import type { ResolvedProvider } from "../src/agent/providers.js";
import { makeSkill } from "./helpers.js";

const HOME = mkdtempSync(path.join(tmpdir(), "eval-"));
const servers: http.Server[] = [];

afterAll(() => {
  for (const server of servers) server.close();
});

function chunk(delta: Record<string, unknown>, finish?: string): string {
  const choice: Record<string, unknown> = { delta };
  if (finish) choice.finish_reason = finish;
  return `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
}

describe("loadEvalSuite", () => {
  it("parses cases with expectations", () => {
    const file = path.join(HOME, "suite.yaml");
    writeFileSync(
      file,
      "name: demo\ncases:\n  - name: a\n    prompt: do a thing\n    expect:\n      tools-used: [write_file]\n",
      "utf8",
    );
    const suite = loadEvalSuite(file);
    expect(suite.name).toBe("demo");
    expect(suite.cases).toHaveLength(1);
    expect(suite.cases[0]?.expect.toolsUsed).toEqual(["write_file"]);
  });

  it("rejects suites without cases or prompts", () => {
    const noCases = path.join(HOME, "no-cases.yaml");
    writeFileSync(noCases, "name: empty\ncases: []\n", "utf8");
    expect(() => loadEvalSuite(noCases)).toThrow("at least one case");
    const noPrompt = path.join(HOME, "no-prompt.yaml");
    writeFileSync(noPrompt, "name: x\ncases:\n  - name: a\n", "utf8");
    expect(() => loadEvalSuite(noPrompt)).toThrow("missing a prompt");
  });
});

describe("runEvalSuite", () => {
  it("evaluates tool/file/command assertions and reports failures", async () => {
    const env = createEnv("eval-env", HOME);
    makeSkill(path.join(env.root, "skills"), "eval-skill", { description: "d" });

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: { role: string; content: string | null }[] };
        const last = parsed.messages.at(-1);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (last?.role === "user" && String(last.content).includes("write the file")) {
          // Case A: write the expected file, then finish.
          if (parsed.messages.some((m) => m.role === "tool")) {
            res.write(`${chunk({ content: "file written." }, "stop")}\n\n`);
          } else {
            res.write(
              `${chunk({ tool_calls: [{ index: 0, id: "w1", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "data" }) } }] }, "tool_calls")}\n\n`,
            );
          }
        } else {
          // Case B: use list_dir once (satisfies tools-used) but never write
          // the expected file, so files-exist must fail.
          if (parsed.messages.some((m) => m.role === "tool")) {
            res.write(`${chunk({ content: "listed." }, "stop")}\n\n`);
          } else {
            res.write(
              `${chunk({ tool_calls: [{ index: 0, id: "l1", function: { name: "list_dir", arguments: "{}" } }] }, "tool_calls")}\n\n`,
            );
          }
        }
        res.end("data: [DONE]\n\n");
      });
    });
    servers.push(server);
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`));
    });
    const provider: ResolvedProvider = { id: "mock", displayName: "Mock", baseUrl: url, apiKey: "", model: "m" };

    const suite: EvalSuite = {
      name: "mock-suite",
      cases: [
        {
          name: "write-case",
          prompt: "write the file",
          expect: {
            toolsUsed: ["write_file"],
            filesExist: ["out.txt"],
            command: ["node", "-e", "process.exit(0)"],
          },
        },
        {
          name: "missing-file-case",
          prompt: "list the directory",
          expect: {
            toolsUsed: ["list_dir"],
            toolsForbidden: ["write_file"],
            filesExist: ["never.txt"],
          },
        },
      ],
    };

    const workdir = mkdtempSync(path.join(tmpdir(), "eval-run-"));
    const report = await runEvalSuite(suite, {
      envRoot: env.root,
      envName: "eval-env",
      provider,
      workdir,
      render: { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
    });

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.passRate).toBe(0.5);
    const [good, bad] = report.results;
    expect(good?.passed).toBe(true);
    expect(good?.toolNames).toEqual(["write_file"]);
    expect(bad?.passed).toBe(false);
    expect(bad?.failures.some((f) => f.includes("never.txt"))).toBe(true);
    // Keep-workdirs mode leaves the case directory for inspection.
    const keepReport = await runEvalSuite({ ...suite, name: "keep" }, {
      envRoot: env.root,
      envName: "eval-env",
      provider,
      workdir,
      keepWorkdirs: true,
      render: { onTextDelta: () => {}, onTurnStart: () => {}, onToolCall: () => {}, onToolResult: () => {}, onInfo: () => {} },
    });
    expect(keepReport.results[0]?.passed).toBe(true);
    const entries = existsSync(workdir) ? requireDir(workdir) : [];
    expect(entries.some((entry) => entry.startsWith(".eval-"))).toBe(true);
  });

  it("chatCompletionStream stays importable for live eval runs", () => {
    expect(typeof chatCompletionStream).toBe("function");
  });
});

function requireDir(dir: string): string[] {
  return readdirSync(dir);
}
