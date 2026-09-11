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
};

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
  options: { temperature?: number; signal?: AbortSignal } = {},
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
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
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
