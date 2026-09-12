/**
 * Provider presets for the built-in agent. Every provider speaks the
 * OpenAI-compatible `/chat/completions` protocol, which covers DeepSeek,
 * Nous (Hermes), Zhipu GLM, Ollama, vLLM, ModelArts MaaS, and any other
 * compatible gateway.
 */
export interface ProviderPreset {
  id: string;
  displayName: string;
  baseUrl: string;
  /** Environment variable holding the API key (empty = no key needed). */
  apiKeyEnv: string;
  defaultModel: string;
  /** Environment variable overriding the default model. */
  modelEnv: string;
  baseUrlEnv?: string;
}

export const PROVIDERS: Record<string, ProviderPreset> = {
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultModel: "deepseek-chat",
    modelEnv: "DEEPSEEK_MODEL",
  },
  nous: {
    id: "nous",
    displayName: "Nous Research (Hermes)",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    apiKeyEnv: "NOUS_API_KEY",
    defaultModel: "Hermes-4-405B",
    modelEnv: "HERMES_MODEL",
  },
  glm: {
    id: "glm",
    displayName: "Zhipu GLM (bigmodel.cn)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "GLM_API_KEY",
    defaultModel: "glm-4.6",
    modelEnv: "GLM_MODEL",
  },
  openai: {
    id: "openai",
    displayName: "OpenAI-compatible (OPENAI_BASE_URL)",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultModel: "gpt-5.2",
    modelEnv: "OPENAI_MODEL",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama (local)",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    defaultModel: "qwen3:8b",
    modelEnv: "OLLAMA_MODEL",
    baseUrlEnv: "OLLAMA_BASE_URL",
  },
  modelarts: {
    id: "modelarts",
    displayName: "Huawei Cloud ModelArts MaaS",
    baseUrl: "",
    apiKeyEnv: "MODELARTS_API_KEY",
    defaultModel: "",
    modelEnv: "MODELARTS_MODEL",
    baseUrlEnv: "MODELARTS_BASE_URL",
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-4-5",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
};

/** Providers that speak the Anthropic Messages protocol instead of OpenAI's. */
export const ANTHROPIC_PROTOCOL_IDS = new Set(["anthropic"]);

export interface ResolvedProvider {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderOverrides {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** Resolve a provider preset + CLI overrides + environment into effective settings. */
export function resolveProvider(overrides: ProviderOverrides = {}): ResolvedProvider {
  const providerId = overrides.provider ?? process.env.SKILLENV_AGENT_PROVIDER ?? "deepseek";
  const preset = PROVIDERS[providerId];
  if (!preset) {
    throw new Error(
      `unknown provider: ${providerId} (available: ${Object.keys(PROVIDERS).join(", ")})`,
    );
  }

  const baseUrl = overrides.baseUrl ?? process.env[preset.baseUrlEnv ?? ""] ?? preset.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `provider '${preset.id}' requires a base URL; set ${preset.baseUrlEnv ?? "--base-url"}`,
    );
  }

  const apiKey =
    overrides.apiKey ?? (preset.apiKeyEnv ? (process.env[preset.apiKeyEnv] ?? "") : "");
  if (preset.apiKeyEnv && apiKey.length === 0) {
    throw new Error(
      `provider '${preset.id}' requires an API key; set ${preset.apiKeyEnv} or pass --api-key`,
    );
  }

  const model =
    overrides.model ??
    process.env[preset.modelEnv] ??
    preset.defaultModel;
  if (!model) {
    throw new Error(
      `provider '${preset.id}' requires a model; set ${preset.modelEnv} or pass --model`,
    );
  }

  return { id: preset.id, displayName: preset.displayName, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

/* ------------------------------------------------------------------ */
/* Streaming chat client                                              */
/* ------------------------------------------------------------------ */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** HTTP-level failure from a provider call; carries the status for retry logic. */
export class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
  }

  /** 429 and 5xx are transient; 4xx (except 429) are not worth retrying. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: StreamUsage;
}

interface DeltaAccumulator {
  content: string;
  toolCalls: Map<number, ToolCall>;
  finishReason: string | null;
}

/**
 * POST a streaming chat completion and invoke `onDelta` for every content
 * token. Tool-call argument fragments are accumulated server-side style and
 * only surfaced in the final result.
 */
export async function chatCompletionStream(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      stream: true,
      stream_options: { include_usage: true },
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new ProviderHttpError(
      response.status,
      `provider request failed: HTTP ${response.status} ${response.statusText}${detail ? `\n${detail.slice(0, 2000)}` : ""}`,
    );
  }

  const accumulator: DeltaAccumulator = { content: "", toolCalls: new Map(), finishReason: null };
  let usage: StreamUsage | undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator: number;
    while ((separator = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, separator).trimEnd();
      buffer = buffer.slice(separator + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let chunk: {
        choices?: {
          delta?: {
            content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: StreamUsage;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) accumulator.finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content) {
        accumulator.content += delta.content;
        onDelta(delta.content);
      }
      for (const toolDelta of delta.tool_calls ?? []) {
        const index = toolDelta.index ?? 0;
        const existing = accumulator.toolCalls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (toolDelta.id) existing.id = toolDelta.id;
        if (toolDelta.function?.name) existing.function.name += toolDelta.function.name;
        if (toolDelta.function?.arguments) existing.function.arguments += toolDelta.function.arguments;
        accumulator.toolCalls.set(index, existing);
      }
    }
  }

  const toolCalls = [...accumulator.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.function.name.length > 0);

  return {
    content: accumulator.content,
    toolCalls,
    finishReason: accumulator.finishReason,
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages protocol                                        */
/* ------------------------------------------------------------------ */

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicSseState {
  text: string;
  blocks: Map<number, { id: string; name: string; json: string }>;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Stream a chat completion over the Anthropic Messages protocol and adapt it
 * to the OpenAI-shaped CompletionResult the agent loop consumes.
 */
export async function anthropicChatCompletionStream(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n\n");
  const conversation: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      // Tool results arrive as user messages with tool_result blocks.
      conversation.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content ?? "" },
        ],
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content: AnthropicContentBlock[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        let input: Record<string, unknown>;
        try {
          input = call.function.arguments.trim().length > 0 ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      conversation.push({ role: "assistant", content });
      continue;
    }
    conversation.push({ role: message.role, content: message.content ?? "" });
  }

  const response = await fetch(`${provider.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: options.maxTokens ?? 16_384,
      ...(system.length > 0 ? { system } : {}),
      messages: conversation,
      ...(tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            })),
          }
        : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new ProviderHttpError(
      response.status,
      `provider request failed: HTTP ${response.status} ${response.statusText}${detail ? `\n${detail.slice(0, 2000)}` : ""}`,
    );
  }

  const state: AnthropicSseState = { text: "", blocks: new Map(), stopReason: null, inputTokens: 0, outputTokens: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator: number;
    while ((separator = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, separator).trimEnd();
      buffer = buffer.slice(separator + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0) continue;
      let event: {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string };
        delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        state.blocks.set(event.index ?? 0, {
          id: event.content_block.id ?? "",
          name: event.content_block.name ?? "",
          json: "",
        });
      } else if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          state.text += event.delta.text;
          onDelta(event.delta.text);
        } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json !== undefined) {
          const block = state.blocks.get(event.index ?? 0);
          if (block) block.json += event.delta.partial_json;
        }
      } else if (event.type === "message_delta") {
        if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens) state.outputTokens = event.usage.output_tokens;
      } else if (event.type === "message_start") {
        state.inputTokens = event.message?.usage?.input_tokens ?? 0;
      }
    }
  }

  const toolCalls: ToolCall[] = [...state.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, block]) => block.name.length > 0)
    .map(([index, block]) => ({
      id: block.id.length > 0 ? block.id : `toolu_${index}`,
      type: "function" as const,
      function: { name: block.name, arguments: block.json.length > 0 ? block.json : "{}" },
    }));

  return {
    content: state.text,
    toolCalls,
    finishReason: state.stopReason === "tool_use" ? "tool_calls" : state.stopReason,
    usage: { prompt_tokens: state.inputTokens, completion_tokens: state.outputTokens },
  };
}

/** Protocol-dispatching entry point used by the agent loop. */
export function streamChat(
  provider: ResolvedProvider,
  messages: ChatMessage[],
  tools: ToolSchema[],
  onDelta: (text: string) => void,
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<CompletionResult> {
  if (ANTHROPIC_PROTOCOL_IDS.has(provider.id)) {
    return anthropicChatCompletionStream(provider, messages, tools, onDelta, options);
  }
  return chatCompletionStream(provider, messages, tools, onDelta, options);
}
