import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAdapter } from "../adapter.js";
import { readLock } from "../lock.js";
import { readSkillMeta, SKILL_FILE } from "../skill.js";
import type { AgentRenderEvents } from "./render.js";
import {
  chatCompletionStream,
  type ChatMessage,
  type CompletionResult,
  type ResolvedProvider,
  type ToolCall,
} from "./providers.js";
import { defaultTools, executeTool, toolSchemas, type ToolContext } from "./tools.js";

export interface AgentOptions {
  envRoot: string;
  envName: string;
  provider: ResolvedProvider;
  /** Failover target when the primary provider fails before any output. */
  fallbackProvider?: ResolvedProvider;
  /** Restrict the toolbox; default is all tools. Unknown names are ignored. */
  tools?: string[];
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
  const allTools = defaultTools();
  const tools = options.tools ? allTools.filter((tool) => options.tools?.includes(tool.name)) : allTools;
  const schemas = toolSchemas(tools);
  const context: ToolContext = { workdir: options.workdir, envRoot: options.envRoot };
  const maxIterations = options.maxIterations ?? 25;

  if (!messages.some((message) => message.role === "system")) {
    messages.unshift({ role: "system", content: buildSystemPrompt(options) });
  }

  let iteration = 0;
  let totalToolCalls = 0;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  /**
   * One streaming request with provider failover: if the primary fails
   * before any content was streamed (connect error, HTTP error), retry once
   * against the fallback provider. Once deltas have reached the terminal, a
   * failure propagates — retrying would duplicate partial output.
   */
  const request = async (
    requestMessages: ChatMessage[],
    requestTools: typeof schemas,
    onDelta: (text: string) => void,
  ): Promise<CompletionResult> => {
    let emitted = 0;
    const counting = (text: string): void => {
      emitted += text.length;
      onDelta(text);
    };
    try {
      return await chatCompletionStream(options.provider, requestMessages, requestTools, counting, {
        temperature: options.temperature,
        signal: options.signal,
      });
    } catch (error) {
      if (emitted > 0 || !options.fallbackProvider) throw error;
      render.onInfo(
        `provider '${options.provider.id}' failed (${(error as Error).message.split("\n")[0]}); failing over to '${options.fallbackProvider.id}'`,
      );
      return chatCompletionStream(options.fallbackProvider, requestMessages, requestTools, counting, {
        temperature: options.temperature,
        signal: options.signal,
      });
    }
  };

  for (;;) {
    iteration += 1;
    if (iteration > maxIterations) {
      render.onInfo(`reached max iterations (${maxIterations}); asking the model for a final summary`);
      // Graceful degradation: one last request with no tools so the model
      // wraps up instead of cutting off mid-work.
      const summary = await request(
        [
          ...messages,
          {
            role: "user",
            content:
              "You have reached the tool-call iteration limit. Stop making changes and give a concise final summary: what you completed, what remains, and how far verification got.",
          },
        ],
        [],
        render.onTextDelta,
      );
      usage.prompt_tokens += summary.usage?.prompt_tokens ?? 0;
      usage.completion_tokens += summary.usage?.completion_tokens ?? 0;
      messages.push({ role: "assistant", content: summary.content });
      return {
        content: summary.content,
        toolCalls: totalToolCalls,
        iterations: iteration,
        usage,
      };
    }
    render.onTurnStart(iteration);

    const completion = await request(messages, schemas, render.onTextDelta);
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
