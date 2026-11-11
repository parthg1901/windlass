import { defaults } from "./defaults.ts"

export type RetryOptions = typeof defaults.retry

/**
 * Delay before retry number `retry` (1-based). The first attempt is not a retry, so with `attempts` total
 * attempts there are `attempts - 1` retries.
 */
export function delayFor(retry: number, options: RetryOptions = defaults.retry) {
  const raw = options.baseDelayMs * options.factor ** (retry - 1)
  return Math.min(raw, options.maxDelayMs)
}

export function* delays(options: RetryOptions = defaults.retry) {
  for (let retry = 1; retry < options.attempts; retry++) yield delayFor(retry, options)
}
