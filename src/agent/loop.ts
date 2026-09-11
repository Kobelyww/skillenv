import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAdapter } from "../adapter.js";
import { readLock } from "../lock.js";
import { readSkillMeta, SKILL_FILE } from "../skill.js";
import type { AgentRenderEvents } from "./render.js";
import {
  chatCompletionStream,
  type ChatMessage,
  type ResolvedProvider,
  type ToolCall,
} from "./providers.js";
import { defaultTools, executeTool, toolSchemas, type ToolContext } from "./tools.js";

export interface AgentOptions {
  envRoot: string;
  envName: string;
  provider: ResolvedProvider;
  workdir: string;
  /** Skill names to inline fully in the system prompt (others are listed + on-demand). */
  inlineSkills?: string[];
  maxIterations?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AgentTurnResult {
  content: string;
  toolCalls: number;
  iterations: number;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/** Build the system prompt: role, workspace, adapter, and skill inventory. */
export function buildSystemPrompt(options: AgentOptions): string {
  const adapter = safeAdapter(options.envRoot);
  const lines: string[] = [
    "You are skillenv agent, a pragmatic coding and working agent.",
    `You operate inside the skillenv environment '${options.envName}' (${options.envRoot}).`,
    `Adapter: ${adapter}. Adapter isolation variables (CODEX_HOME/CLAUDE_CONFIG_DIR/...) are NOT active for you; your tools work on the filesystem directly.`,
    `Working directory: ${options.workdir}`,
    "",
    "Guidelines:",
    "- Inspect before you edit: read files, list directories, grep for context.",
    "- Prefer edit_file over rewriting whole files; keep diffs minimal.",
    "- run_command executes real shell commands with a timeout; use it to build, test, and verify.",
    "- web_fetch reaches public URLs only (private networks are blocked).",
    "- Skills installed in this environment are domain playbooks. Use skill_list to see them and skill_read to load one before following it.",
    "- When a task is complete, summarize concisely what changed and how you verified it.",
  ];

  const inline = inlineSkillText(options);
  if (inline.length > 0) {
    lines.push("", "# Inlined skills", inline);
  }
  return lines.join("\n");
}

function safeAdapter(envRoot: string): string {
  const manifest = path.join(envRoot, "skillenv.yml");
  try {
    const text = readFileSync(manifest, "utf8");
    const match = /^adapter:\s*(\S+)/m.exec(text);
    if (match?.[1]) {
      const spec = getAdapter(match[1]);
      return `${spec.id} (${spec.displayName})`;
    }
  } catch {
    /* fall through */
  }
  return "codex (default)";
}

function inlineSkillText(options: AgentOptions): string {
  const wanted = new Set((options.inlineSkills ?? []).map((name) => name.trim()).filter(Boolean));
  if (wanted.size === 0) return "";
  const skillsDir = path.join(options.envRoot, "skills");
  const chunks: string[] = [];
  if (statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of wanted) {
      const file = path.join(skillsDir, name, SKILL_FILE);
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
      chunks.push(`## skill: ${name}\n\n${readFileSync(file, "utf8").trim()}`);
    }
  }
  return chunks.join("\n\n");
}

/**
 * Run one user request through the tool-calling loop until the model answers
 * without tool calls or `maxIterations` is reached. Streams text deltas via
 * `render`.
 */
export async function runAgentTurn(
  options: AgentOptions,
  messages: ChatMessage[],
  render: AgentRenderEvents,
): Promise<AgentTurnResult> {
  const tools = defaultTools();
  const schemas = toolSchemas(tools);
  const context: ToolContext = { workdir: options.workdir, envRoot: options.envRoot };
  const maxIterations = options.maxIterations ?? 25;

  if (!messages.some((message) => message.role === "system")) {
    messages.unshift({ role: "system", content: buildSystemPrompt(options) });
  }

  let iteration = 0;
  let totalToolCalls = 0;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  for (;;) {
    iteration += 1;
    if (iteration > maxIterations) {
      render.onInfo(`reached max iterations (${maxIterations}); stopping`);
      break;
    }
    render.onTurnStart(iteration);

    const completion = await chatCompletionStream(
      options.provider,
      messages,
      schemas,
      render.onTextDelta,
      { temperature: options.temperature, signal: options.signal },
    );
    usage.prompt_tokens += completion.usage?.prompt_tokens ?? 0;
    usage.completion_tokens += completion.usage?.completion_tokens ?? 0;

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: completion.content.length > 0 ? completion.content : null,
      ...(completion.toolCalls.length > 0 ? { tool_calls: completion.toolCalls } : {}),
    };
    messages.push(assistantMessage);

    if (completion.toolCalls.length === 0) {
      return { content: completion.content, toolCalls: totalToolCalls, iterations: iteration, usage };
    }

    for (const call of completion.toolCalls as ToolCall[]) {
      totalToolCalls += 1;
      render.onToolCall(call.function.name, call.function.arguments);
      const result = await executeTool(tools, context, call);
      render.onToolResult(call.function.name, result.ok, result.output);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result.output,
      });
    }
  }

  return { content: "", toolCalls: totalToolCalls, iterations: iteration, usage };
}

/** Skills recorded in the environment lock, for session provenance. */
export function envSkillNames(envRoot: string): string[] {
  return readLock(envRoot).skills.map((skill) => skill.name);
}

/** Skills physically present in the environment (lock-independent). */
export function presentSkillNames(envRoot: string): string[] {
  const skillsDir = path.join(envRoot, "skills");
  if (!statSync(skillsDir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(skillsDir)
    .filter((entry) => statSync(path.join(skillsDir, entry), { throwIfNoEntry: false })?.isDirectory())
    .sort();
}

/** One-line description of a skill for listings. */
export function skillSummary(envRoot: string, name: string): string {
  const meta = readSkillMeta(path.join(envRoot, "skills", name));
  return meta.description ?? "(no description)";
}
