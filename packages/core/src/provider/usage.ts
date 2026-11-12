import { type Infer, integer, object, optional } from "../validate.ts"

/**
 * Token counts for one model call, as measured by the provider.
 * - `inputTokens`: all input tokens, including the cached ones and the ones
 *   written to the cache.
 * - `cachedInputTokens`: the part of `inputTokens` served from the prompt cache.
 * - `outputTokens`: all output tokens, including reasoning tokens.
 * - `reasoningTokens`: the part of `outputTokens` spent on reasoning.
 * - `cacheWriteTokens`: the part of `inputTokens` the provider says it wrote
 *   to the prompt cache. Present exactly when the provider reported the
 *   figure, zero included; absent when it reports no writes at all.
 * - `cacheWrite12hTokens`: the part of `cacheWriteTokens` written with the
 *   12-hour lifetime, when the provider reported the split.
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
  cacheWriteTokens: optional(integer(0)),
  cacheWrite12hTokens: optional(integer(0)),
})
export type Usage = Infer<typeof usage>

/**
 * The usage of two calls added up. A cache-write figure is in the sum when
 * either call reported one: the sum then says what was reported, and stays
 * absent when neither provider call said anything about writes.
 */
export function sumUsage(a: Usage, b: Usage): Usage {
  const reported = (x: number | undefined, y: number | undefined) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0))
  const cacheWriteTokens = reported(a.cacheWriteTokens, b.cacheWriteTokens)
  const cacheWrite12hTokens = reported(a.cacheWrite12hTokens, b.cacheWrite12hTokens)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(cacheWrite12hTokens === undefined ? {} : { cacheWrite12hTokens }),
  }
}
