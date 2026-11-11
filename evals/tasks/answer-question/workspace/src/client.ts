import { delays } from "./backoff.ts"
import { defaults } from "./defaults.ts"

export interface ClientOptions {
  readonly retry?: Partial<typeof defaults.retry>
}

/** The HTTP client used by the app. It retries 5xx responses using the backoff schedule. */
export function createClient(options: ClientOptions = {}) {
  const retry = { ...defaults.retry, ...options.retry }
  return {
    async get(url: string) {
      for (const wait of [0, ...delays(retry)]) {
        if (wait > 0) await Bun.sleep(wait)
        const response = await fetch(url, { signal: AbortSignal.timeout(defaults.timeoutMs) })
        if (response.status < 500) return response
      }
      throw new Error(`gave up on ${url}`)
    },
  }
}
