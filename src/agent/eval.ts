import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { runAgentTurn } from "./loop.js";
import { resolveProvider, type ChatMessage, type ResolvedProvider } from "./providers.js";
import type { AgentRenderEvents } from "./render.js";

/** One evaluation case: a prompt plus assertions about what the agent did. */
export interface EvalCase {
  name: string;
  prompt: string;
  /** Per-case provider override (A/B model comparison); defaults to the run-level provider. */
  provider?: string;
  model?: string;
  maxIterations?: number;
  expect: {
    /** Tool names that must appear in the turn (in any order). */
    toolsUsed?: string[];
    /** Tool names that must NOT appear. */
    toolsForbidden?: string[];
    /** Files that must exist relative to the case workdir after the run. */
    filesExist?: string[];
    /** Command run after the agent finishes; must exit 0. */
    command?: string[];
    /** Strings that must appear (case-insensitive) in the agent's final answer. */
    agentContains?: string[];
  };
}

export interface EvalSuite {
  name: string;
  /** Per-case isolation directory root; a fresh temp dir by default. */
  cases: EvalCase[];
}

export interface EvalCaseResult {
  name: string;
  passed: boolean;
  failures: string[];
  toolNames: string[];
  iterations: number;
  provider: string;
  model: string;
}

export interface EvalReport {
  suite: string;
  provider: string;
  model: string;
  results: EvalCaseResult[];
  passed: number;
  total: number;
  passRate: number;
}

export function loadEvalSuite(file: string): EvalSuite {
  const resolved = file.replace(/^~(?=\/|$)/, process.env.HOME ?? "");
  if (!existsSync(resolved)) {
    throw new Error(`eval suite not found: ${file}`);
  }
  let data: unknown;
  try {
    data = parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`eval suite is not valid YAML: ${(error as Error).message}`, { cause: error });
  }
  const map = (data ?? {}) as Record<string, unknown>;
  const rawCases = Array.isArray(map.cases) ? map.cases : [];
  if (rawCases.length === 0) {
    throw new Error("eval suite must define at least one case");
  }
  const cases: EvalCase[] = rawCases.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : `case-${index + 1}`;
    const prompt = typeof entry.prompt === "string" ? entry.prompt : "";
    if (prompt.length === 0) {
      throw new Error(`eval case '${name}' is missing a prompt`);
    }
    const expect = (entry.expect ?? {}) as Record<string, unknown>;
    const stringList = (value: unknown): string[] | undefined =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    return {
      name,
      prompt,
      provider: typeof entry.provider === "string" ? entry.provider : undefined,
      model: typeof entry.model === "string" ? entry.model : undefined,
      maxIterations: typeof entry["max-iterations"] === "number" ? entry["max-iterations"] : undefined,
      expect: {
        toolsUsed: stringList(expect["tools-used"]),
        toolsForbidden: stringList(expect["tools-forbidden"]),
        filesExist: stringList(expect["files-exist"]),
        command: stringList(expect.command),
        agentContains: stringList(expect["agent-contains"]),
      },
    };
  });
  return { name: typeof map.name === "string" ? map.name : path.basename(resolved), cases };
}

export interface RunEvalOptions {
  envRoot: string;
  envName: string;
  provider: ResolvedProvider;
  fallbackProvider?: ResolvedProvider;
  workdir: string;
  keepWorkdirs?: boolean;
  render: AgentRenderEvents;
  compactChars?: number;
  /** Default iteration cap for cases that do not set their own. */
  defaultMaxIterations?: number;
}

/**
 * Run every case in a fresh workdir inside the given environment and evaluate
 * the expectations. Tool-sequence, file-existence, and exit-code assertions
 * make agent behavior regression-testable — the same idea as a unit suite,
 * but for the model-driven loop.
 */
export async function runEvalSuite(suite: EvalSuite, options: RunEvalOptions): Promise<EvalReport> {
  const results: EvalCaseResult[] = [];
  const suiteRoot =
    options.keepWorkdirs === true
      ? path.join(options.workdir, `.eval-${Date.now()}`)
      : mkdtempSync(path.join(tmpdir(), "skillenv-eval-"));

  try {
    for (const evalCase of suite.cases) {
      const caseDir = path.join(suiteRoot, evalCase.name.replace(/[^a-zA-Z0-9_-]+/g, "-"));
      mkdirSync(caseDir, { recursive: true });
      const failures: string[] = [];
      let toolNames: string[] = [];
      let iterations = 0;

      let caseProvider = options.provider;
      if (evalCase.provider) {
        caseProvider = resolveProvider({ provider: evalCase.provider, model: evalCase.model });
      }

      const messages: ChatMessage[] = [{ role: "user", content: evalCase.prompt }];
      const result = await runAgentTurn(
        {
          envRoot: options.envRoot,
          envName: options.envName,
          provider: caseProvider,
          fallbackProvider: options.fallbackProvider,
          workdir: caseDir,
          maxIterations: evalCase.maxIterations ?? options.defaultMaxIterations,
          compactChars: options.compactChars,
        },
        messages,
        options.render,
      );
      toolNames = result.toolNames;
      iterations = result.iterations;

      for (const tool of evalCase.expect.toolsUsed ?? []) {
        if (!toolNames.includes(tool)) {
          failures.push(`expected tool '${tool}' to be used; used: ${toolNames.join(", ") || "none"}`);
        }
      }
      for (const tool of evalCase.expect.toolsForbidden ?? []) {
        if (toolNames.includes(tool)) {
          failures.push(`tool '${tool}' was used but is forbidden`);
        }
      }
      for (const text of evalCase.expect.agentContains ?? []) {
        if (!result.content.toLowerCase().includes(text.toLowerCase())) {
          failures.push(`expected final answer to contain '${text}'`);
        }
      }
      for (const file of evalCase.expect.filesExist ?? []) {
        if (!statSync(path.join(caseDir, file), { throwIfNoEntry: false })?.isFile()) {
          failures.push(`expected file to exist: ${file}`);
        }
      }
      if (evalCase.expect.command && evalCase.expect.command.length > 0) {
        const verify = spawnSync(evalCase.expect.command[0] as string, evalCase.expect.command.slice(1), {
          cwd: caseDir,
          encoding: "utf8",
          timeout: 120_000,
        });
        if (verify.status !== 0) {
          failures.push(
            `verification command failed (exit ${verify.status}): ${verify.stdout ?? ""}${verify.stderr ?? ""}`.slice(0, 800),
          );
        }
      }

      results.push({
        name: evalCase.name,
        passed: failures.length === 0,
        failures,
        toolNames,
        iterations,
        provider: caseProvider.id,
        model: caseProvider.model,
      });
    }
  } finally {
    if (options.keepWorkdirs !== true) {
      rmSync(suiteRoot, { recursive: true, force: true });
    }
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    suite: suite.name,
    provider: options.provider.id,
    model: options.provider.model,
    results,
    passed,
    total: results.length,
    passRate: results.length > 0 ? passed / results.length : 0,
  };
}
