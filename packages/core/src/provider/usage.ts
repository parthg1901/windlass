import { type Infer, integer, object } from "../validate.ts"

/**
 * Token counts for one model call, as measured by the provider.
 * - `inputTokens`: all input tokens, including the cached ones.
 * - `cachedInputTokens`: the part of `inputTokens` served from the prompt cache.
 * - `outputTokens`: all output tokens, including reasoning tokens.
 * - `reasoningTokens`: the part of `outputTokens` spent on reasoning.
 *
 * So uncached input is `inputTokens - cachedInputTokens`, and the total is
 * `inputTokens + outputTokens`. A provider that reports these differently
 * converts to this shape at its boundary.
 */
export const usage = object({
  inputTokens: integer(0),
  cachedInputTokens: integer(0),
  outputTokens: integer(0),
  reasoningTokens: integer(0),
})
export type Usage = Infer<typeof usage>
