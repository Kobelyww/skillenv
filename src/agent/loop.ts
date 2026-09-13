import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAdapter } from "../adapter.js";
import { readLock } from "../lock.js";
import { readSkillMeta, SKILL_FILE } from "../skill.js";
import type { AgentRenderEvents } from "./render.js";
import {
  streamChat,
  ProviderHttpError,
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
  /** Ask before every shell command (see ToolContext.confirmShell). */
  confirmShell?: (command: string) => Promise<boolean>;
  workdir: string;
  /** Skill names to inline fully in the system prompt (others are listed + on-demand). */
  inlineSkills?: string[];
  /** Extra instructions appended verbatim to the system prompt. */
  systemExtra?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Approximate character budget for the conversation; older tool outputs and
   * assistant turns are replaced with placeholders when exceeded (roles and
   * tool_call ids are preserved so pairing stays valid). 0 disables.
   */
  compactChars?: number;
}

/** Rough size of a message: content plus tool-call payloads. */
function messageSize(message: ChatMessage): number {
  let size = typeof message.content === "string" ? message.content.length : 0;
  for (const call of message.tool_calls ?? []) {
    size += call.function.name.length + call.function.arguments.length;
  }
  return size;
}

export const COMPACT_PLACEHOLDER = "[earlier content omitted to fit the context budget]";

/**
 * Shrink a conversation that exceeds `maxChars` by replacing the *payloads*
 * of older messages with placeholders. Structure is never touched: roles,
 * ordering, and tool_call ids survive, so assistant→tool pairing stays valid
 * for the provider. System, first-user, and the most recent messages are
 * always kept verbatim. Returns the (possibly same) array and whether any
 * content was replaced.
 */
export function compactMessages(
  messages: ChatMessage[],
  maxChars: number,
): { messages: ChatMessage[]; compacted: boolean } {
  if (maxChars <= 0) return { messages, compacted: false };
  const sizeOf = (list: ChatMessage[]): number => list.reduce((sum, m) => sum + messageSize(m), 0);
  if (sizeOf(messages) <= maxChars) return { messages, compacted: false };

  // Never touch the system prompt, the first user message, or the tail.
  // The tail guard is at most a third of the conversation, so a short
  // transcript with a few huge tool outputs can still be compacted.
  const keepTail = Math.min(12, Math.max(2, Math.floor(messages.length / 3)));
  const firstUser = messages.findIndex((m) => m.role === "user");
  const compactableEnd = Math.max(0, messages.length - keepTail);
  // Deep-copy tool_call payloads: compaction rewrites arguments in place and
  // must never mutate the caller's conversation history.
  const out = messages.map((m) => ({
    ...m,
    tool_calls: m.tool_calls?.map((call) => ({
      ...call,
      function: { ...call.function },
    })),
  }));
  let compacted = false;

  // Compact tool outputs first (they dominate size), then assistant turns,
  // walking outward-in from the compactable middle.
  for (let index = 1; index < compactableEnd; index++) {
    const message = out[index];
    if (!message) continue;
    if (message.role === "tool" && message.content && message.content.length > 200) {
      message.content = COMPACT_PLACEHOLDER;
      compacted = true;
    }
    if (sizeOf(out) <= maxChars) return { messages: out, compacted };
  }
  for (let index = compactableEnd - 1; index > Math.max(firstUser, 0); index--) {
    const message = out[index];
    if (!message) continue;
    if (message.role === "assistant") {
      if (message.content && message.content.length > 200) {
        message.content = COMPACT_PLACEHOLDER;
        compacted = true;
      }
      for (const call of message.tool_calls ?? []) {
        if (call.function.arguments.length > 200) {
          call.function.arguments = "{}";
          compacted = true;
        }
      }
    }
    if (sizeOf(out) <= maxChars) return { messages: out, compacted };
  }
  return { messages: out, compacted };
}

export interface AgentTurnResult {
  content: string;
  toolCalls: number;
  /** Ordered names of every tool invoked during the turn. */
  toolNames: string[];
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
    "- You have persistent memory across sessions (memory_read/memory_write). At the start of a task, read memory if it may hold relevant context; when the user states a durable preference or a task ends with a reusable lesson, record it with memory_write. Never store secrets there.",
    "- When a task is complete, summarize concisely what changed and how you verified it.",
  ];

  const inline = inlineSkillText(options);
  if (inline.length > 0) {
    lines.push("", "# Inlined skills", inline);
  }

  // Deterministic memory recall: non-empty memory is injected into every
  // session's system prompt (never trusted to the model's initiative).
  const memory = readMemoryText(options.envRoot);
  if (memory) {
    lines.push("", "# Persistent memory (from previous sessions)", memory);
  }

  if (options.systemExtra && options.systemExtra.trim().length > 0) {
    lines.push("", "# Additional instructions", options.systemExtra.trim());
  }
  return lines.join("\n");
}

const MEMORY_INJECT_LIMIT = 4000;

function readMemoryText(envRoot: string): string {
  try {
    const text = readFileSync(path.join(envRoot, "memory", "MEMORY.md"), "utf8").trim();
    if (text.length === 0) return "";
    const body = text.length > MEMORY_INJECT_LIMIT ? `${text.slice(0, MEMORY_INJECT_LIMIT)}\n… (truncated)` : text;
    return `${body}\n(This memory persists across sessions. Follow it unless the user overrides it.)`;
  } catch {
    return "";
  }
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
  const context: ToolContext = {
    workdir: options.workdir,
    envRoot: options.envRoot,
    confirmShell: options.confirmShell,
  };
  const maxIterations = options.maxIterations ?? 25;

  if (!messages.some((message) => message.role === "system")) {
    messages.unshift({ role: "system", content: buildSystemPrompt(options) });
  }

  // Trim the conversation to the context budget before the first request.
  // compactMessages returns a new array; splice it back in place because the
  // session persists this same array object.
  const budget = options.compactChars ?? 120_000;
  const compacted = compactMessages(messages, budget);
  if (compacted.compacted) {
    messages.length = 0;
    messages.push(...compacted.messages);
    render.onInfo(
      `context exceeded ~${budget} characters; older tool outputs and turns were compacted`,
    );
  }

  let iteration = 0;
  let totalToolCalls = 0;
  const toolNames: string[] = [];
  let overflowRetried = false;
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  /**
   * One streaming request with production reliability semantics:
   * - retryable failures (network errors, HTTP 429/5xx) are retried with
   *   exponential backoff against the primary provider;
   * - when retries are exhausted and a fallback provider is configured, the
   *   request moves to the fallback once (same retry budget);
   * - if any content already streamed to the terminal, failures propagate —
   *   retrying would duplicate partial output.
   */
  const withRetries = async (
    provider: ResolvedProvider,
    requestMessages: ChatMessage[],
    requestTools: typeof schemas,
    onDelta: (text: string) => void,
    attempts: number,
  ): Promise<CompletionResult> => {
    let lastError: unknown;
    let streamed = 0;
    const counting = (text: string): void => {
      streamed += text.length;
      onDelta(text);
    };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await streamChat(provider, requestMessages, requestTools, counting, {
          temperature: options.temperature,
          signal: options.signal,
        });
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof ProviderHttpError) || error.retryable;
        // Any token that already reached the terminal forbids a retry: the
        // new attempt would regenerate from scratch and duplicate output.
        if (streamed > 0 || !retryable || attempt >= attempts) {
          throw error;
        }
        const delayMs = 500 * 2 ** (attempt - 1);
        render.onInfo(
          `provider '${provider.id}' attempt ${attempt} failed (${(error as Error).message.split("\n")[0]}); retrying in ${delayMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  };

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
      return await withRetries(options.provider, requestMessages, requestTools, counting, 3);
    } catch (error) {
      // Provider-side context overflow: compact much harder and retry once
      // before giving up (failover rules below still apply afterwards).
      const message = (error as Error).message;
      const contextOverflow =
        /context|maximum.{0,20}length|too many tokens|input.{0,20}long|prompt.{0,20}long/i.test(message);
      if (
        contextOverflow &&
        !overflowRetried &&
        requestMessages.length > 4
      ) {
        overflowRetried = true;
        render.onInfo("provider reported a context overflow; compacting aggressively and retrying");
        const forced = compactMessages(requestMessages, 24_000);
        requestMessages.length = 0;
        requestMessages.push(...forced.messages);
        return streamChat(options.provider, requestMessages, requestTools, onDelta, {
          temperature: options.temperature,
          signal: options.signal,
        });
      }
      if (emitted > 0 || !options.fallbackProvider) throw error;
      render.onInfo(
        `provider '${options.provider.id}' failed (${(error as Error).message.split("\n")[0]}); failing over to '${options.fallbackProvider.id}'`,
      );
      return withRetries(options.fallbackProvider, requestMessages, requestTools, counting, 3);
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
        toolNames,
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
      if (completion.finishReason === "max_tokens") {
        render.onInfo("warning: the model hit its output token limit; consider --max-tokens");
      }
      return { content: completion.content, toolCalls: totalToolCalls, toolNames, iterations: iteration, usage };
    }

    const calls = completion.toolCalls as ToolCall[];
    totalToolCalls += calls.length;
    for (const call of calls) {
      toolNames.push(call.function.name);
      render.onToolCall(call.function.name, call.function.arguments);
    }
    // Independent tool calls from the same turn run concurrently; results are
    // re-joined in the model's original order so the transcript stays aligned
    // with each tool_call id.
    const results = await Promise.all(calls.map((call) => executeTool(tools, context, call)));
    calls.forEach((call, index) => {
      const result = results[index] as { ok: boolean; output: string };
      render.onToolResult(call.function.name, result.ok, result.output);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: result.output,
      });
    });
  }
}

/** Tool names active for an agent run (allowlist applied). */
export function presentToolNames(allowlist?: string[]): string[] {
  const all = defaultTools();
  const active = allowlist ? all.filter((tool) => allowlist.includes(tool.name)) : all;
  return active.map((tool) => tool.name);
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
