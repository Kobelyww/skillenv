/**
 * Cost estimation for model token usage (USD per 1M tokens, input/output).
 * Approximate published prices; unknown models estimate to 0 so tracking
 * never crashes, it just reports free.
 */

const TABLE: { match: RegExp; input: number; output: number }[] = [
  { match: /deepseek-reasoner/i, input: 0.55, output: 2.19 },
  { match: /deepseek-chat|deepseek-v3/i, input: 0.27, output: 1.1 },
  { match: /claude-opus/i, input: 15, output: 75 },
  { match: /claude-sonnet/i, input: 3, output: 15 },
  { match: /claude-3-5-haiku|claude-haiku/i, input: 0.8, output: 4 },
  { match: /claude/i, input: 3, output: 15 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
  { match: /gpt-4\.1-mini|gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /o[34]-mini/i, input: 1.1, output: 4.4 },
  { match: /o[13]/i, input: 2, output: 8 },
  { match: /gemini-2(\.\d)?-pro/i, input: 1.25, output: 10 },
  { match: /gemini-2(\.\d)?-flash/i, input: 0.075, output: 0.3 },
  { match: /glm-4/i, input: 0.6, output: 2.2 },
];

export function estimateCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number }): number {
  if (!usage) return 0;
  const inTokens = usage.prompt_tokens ?? 0;
  const outTokens = usage.completion_tokens ?? 0;
  if (inTokens === 0 && outTokens === 0) return 0;
  for (const entry of TABLE) {
    if (entry.match.test(model)) {
      return Number(((inTokens / 1e6) * entry.input + (outTokens / 1e6) * entry.output).toFixed(6));
    }
  }
  return 0;
}
