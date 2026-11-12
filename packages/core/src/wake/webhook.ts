/**
 * Inbound webhooks: one route, `POST /w/<wake-up id>`, on a small HTTP server bound to 127.0.0.1 by default.
 *
 * Two signature schemes, both HMAC-SHA256 with the wake-up's own secret:
 * - native: `X-Wake-Timestamp: <unix seconds>` and `X-Wake-Signature: v1=<hex>` over `<timestamp>.<body>`. The
 *   timestamp must be within five minutes of the listener's clock, and each signature is accepted once.
 * - GitHub style: `X-Hub-Signature-256: sha256=<hex>` over the body, as GitHub sends it. It has no timestamp, so
 *   each signature is accepted once for the life of the wake-up: a resent delivery, or a captured request
 *   replayed later, is refused. Its `ping` event (sent when the webhook is set up) is answered and fires nothing.
 * The `v1=` and `sha256=` prefixes may be left out, and the hex is lowercase. "Accepted once" is of the signature,
 * not of the header as written: the same signature with or without its prefix is refused the second time.
 * Signatures are compared in constant time. An unknown wake-up is checked against a random key, so it takes as
 * long as a known one, and every refusal before the signature is proven valid is the same 401 with the same body:
 * nothing tells a caller which wake-ups exist. A valid request is recorded as a firing before the 202 is sent.
 *
 * Limits: the body (64 KiB, Content-Length or not), a global rate (30 requests a minute, bursts of 10), at most 8
 * requests in progress, and after a valid signature the wake-up's minimum interval and the session's hourly
 * ceiling (429 with Retry-After). Any other method or path is 404.
 *
 * Several harness processes share the port: the first to bind it listens, the others retry every 30 s, and any of
 * them delivers what was recorded. With no pending webhook wake-up nothing listens at all.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { type WakeClock, systemClock } from "./clock.ts"
import { firingText } from "./message.ts"
import { WAKE_LIMITS } from "./record.ts"
import type { WakeStore } from "./store.ts"

export const SIGNATURE_HEADER = "x-wake-signature"
export const TIMESTAMP_HEADER = "x-wake-timestamp"
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256"
export const DEFAULT_WEBHOOK_PORT = 47_863

/** The headers of a native signed request. For tests, the demo and any sender written in TypeScript. */
export function signWebhook(secret: string, body: string | Uint8Array, timestampSeconds: number): Record<string, string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  return { [TIMESTAMP_HEADER]: String(timestampSeconds), [SIGNATURE_HEADER]: `v1=${nativeMac(secret, String(timestampSeconds), bytes)}` }
}

/** The header GitHub sends: `sha256=<hex>` of the body. */
export function signGithubStyle(secret: string, body: string | Uint8Array): Record<string, string> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  return { [GITHUB_SIGNATURE_HEADER]: `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}` }
}

function nativeMac(secret: string, timestamp: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")
}

export interface WebhookListenerOptions {
  readonly store: WakeStore
  readonly clock?: WakeClock
  /** Default 127.0.0.1. Anything that is not a loopback address needs `allowExternal`. */
  readonly host?: string
  /** Default `DEFAULT_WEBHOOK_PORT`; 0 picks a free port (tests). */
  readonly port?: number
  /** Required to listen on a non-loopback address; `warn` is then told once what that exposes. */
  readonly allowExternal?: boolean
  readonly maxBodyBytes?: number
  readonly requestsPerMinute?: number
  readonly shownBodyBytes?: number
  /** Called after a firing was recorded: poke the scheduler. */
  readonly onFiring?: () => void
  readonly warn?: (message: string) => void
  /** Values to redact from bodies before they are frozen into a message. */
  readonly secrets?: () => readonly string[]
  /** How often to look for new webhook wake-ups and retry a port another process holds. Default 30 s. */
  readonly refreshMs?: number
}

export interface WebhookListener {
  /** Starts listening if a pending webhook wake-up exists, and keeps checking. */
  readonly start: () => void
  /** Look now: listen if needed, stop if nothing needs it. Returns whether it listens. */
  readonly refresh: () => boolean
  /** `http://host:port`, while listening. */
  readonly url: () => string | null
  readonly stop: () => Promise<void>
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])
const REFUSED = { error: "The signature is missing, invalid, stale or was already used." }
const MAX_IN_FLIGHT = 8

export function createWebhookListener(options: WebhookListenerOptions): WebhookListener {
  const store = options.store
  const clock = options.clock ?? systemClock
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? DEFAULT_WEBHOOK_PORT
  const maxBody = Math.min(options.maxBodyBytes ?? WAKE_LIMITS.webhook.maxBodyBytes, WAKE_LIMITS.webhook.maxBodyBytes)
  const perMinute = Math.min(options.requestsPerMinute ?? WAKE_LIMITS.webhook.requestsPerMinute, WAKE_LIMITS.webhook.requestsPerMinute)
  const shownBytes = options.shownBodyBytes ?? WAKE_LIMITS.webhook.shownBytes
  const external = !LOOPBACK.has(host)
  if (external && options.allowExternal !== true) throw new Error(`the webhook listener binds to loopback only unless allowExternal is set; refusing to listen on ${host}`)
  // Unknown wake-ups are checked against this, so that they cost the same as known ones.
  const decoy = randomBytes(32).toString("hex")
  const bucket = { tokens: Math.min(10, perMinute), at: clock.now() }
  let server: ReturnType<typeof Bun.serve> | null = null
  let inFlight = 0
  let warned = false
  let running = false
  let sleeper: AbortController | null = null
  let loop: Promise<void> | null = null

  const take = () => {
    const now = clock.now()
    bucket.tokens = Math.min(Math.min(10, perMinute), bucket.tokens + ((now - bucket.at) / 60_000) * perMinute)
    bucket.at = now
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  const json = (status: number, body: object, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
  const refused = () => json(401, REFUSED)

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const match = /^\/w\/([A-Za-z0-9_]{1,64})$/.exec(url.pathname)
    if (request.method !== "POST" || match === null) return json(404, { error: "Not found." })
    if (!take()) return json(429, { error: "Too many requests." }, { "retry-after": "10" })
    const length = Number(request.headers.get("content-length") ?? "0")
    if (Number.isFinite(length) && length > maxBody) return json(413, { error: `The body is larger than ${maxBody} bytes.` })
    const body = await readCapped(request, maxBody)
    if (body === null) return json(413, { error: `The body is larger than ${maxBody} bytes.` })

    const id = match[1]!
    const secret = store.secret(id)
    const key = secret ?? decoy
    const native = request.headers.get(SIGNATURE_HEADER)
    const github = request.headers.get(GITHUB_SIGNATURE_HEADER)
    const now = clock.now()
    let digest: string
    let seenUntil: number
    if (native !== null) {
      const timestamp = request.headers.get(TIMESTAMP_HEADER) ?? ""
      const expected = nativeMac(key, timestamp, body)
      const valid = equalHex(native.replace(/^v1=/, ""), expected)
      const seconds = /^\d{1,12}$/.test(timestamp) ? Number(timestamp) : Number.NaN
      const fresh = Math.abs(now - seconds * 1000) <= WAKE_LIMITS.webhook.toleranceMs
      if (!valid || !fresh || secret === null) return refused()
      // What is remembered is the signature itself, the MAC it was found equal to, never the header as written: a
      // replay with the prefix taken off (or written any other way that is accepted) is the same signature.
      digest = `v1:${expected}`
      seenUntil = seconds * 1000 + WAKE_LIMITS.webhook.toleranceMs
    } else if (github !== null) {
      const expected = createHmac("sha256", key).update(body).digest("hex")
      const valid = equalHex(github.replace(/^sha256=/, ""), expected)
      if (!valid || secret === null) return refused()
      // GitHub sends a signed `ping` when the webhook is set up: answer it, fire nothing.
      if (request.headers.get("x-github-event") === "ping") return json(200, { pong: true })
      digest = `gh:${expected}`
      seenUntil = Number.MAX_SAFE_INTEGER
    } else {
      // Still compute one MAC, so a request without a signature costs what one with a bad signature costs.
      equalHex("", nativeMac(key, "", body))
      return refused()
    }

    const outcome = store.recordWebhook(id, {
      digest,
      seenUntil,
      now,
      text: (wake, n) =>
        firingText({
          wake,
          n,
          source: "webhook",
          dueAt: now,
          now,
          webhook: { body, receivedAt: now, contentType: printable(request.headers.get("content-type")), event: printable(request.headers.get("x-github-event")) },
          shownBodyBytes: shownBytes,
          secrets: options.secrets?.() ?? [],
        }),
    })
    switch (outcome.kind) {
      case "accepted":
        options.onFiring?.()
        return json(202, { accepted: true })
      case "replayed":
      case "unavailable":
        return refused()
      case "limited":
        return json(429, { error: "Too many requests for this webhook; retry later." }, { "retry-after": String(Math.ceil(outcome.retryAfterMs / 1000)) })
    }
  }

  const listen = () => {
    if (server !== null) return true
    try {
      server = Bun.serve({
        hostname: host,
        port,
        // Bun refuses a larger body itself; `readCapped` covers a body sent without a length.
        maxRequestBodySize: maxBody + 1,
        idleTimeout: 10,
        fetch: async (request) => {
          if (inFlight >= MAX_IN_FLIGHT) return json(429, { error: "Too many requests." }, { "retry-after": "5" })
          inFlight += 1
          try {
            return await handle(request)
          } catch {
            return json(500, { error: "The request could not be recorded." })
          } finally {
            inFlight -= 1
          }
        },
        error: () => json(400, { error: "Bad request." }),
      })
    } catch {
      // Another harness process has the port: it records what arrives, and the store is shared.
      return false
    }
    if (external && !warned) {
      warned = true
      options.warn?.(
        `The webhook listener is bound to ${host}:${server.port}, which other machines can reach. Requests are verified by their signature, but anyone who can reach it can make the harness do work to refuse them. Bind to 127.0.0.1 and use a tunnel unless you need this.`,
      )
    }
    return true
  }

  const refresh = () => {
    const needed = store.hasActiveWebhooks()
    if (needed) return listen()
    if (server !== null) {
      server.stop(true)
      server = null
    }
    return false
  }

  return {
    refresh,
    url: () => (server === null ? null : `http://${host.includes(":") ? `[${host}]` : host}:${server.port}`),
    start: () => {
      if (running) return
      running = true
      loop = (async () => {
        while (running) {
          try {
            refresh()
          } catch {
            // The store is shared; a busy moment is not a reason to stop.
          }
          sleeper = new AbortController()
          await clock.sleep(options.refreshMs ?? 30_000, sleeper.signal)
        }
      })()
    },
    stop: async () => {
      running = false
      sleeper?.abort()
      await loop
      if (server !== null) {
        await server.stop(true)
        server = null
      }
    },
  }
}

/** The body, or `null` once it is longer than `max`. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of request.body) {
    total += chunk.length
    if (total > max) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function equalHex(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8")
  const b = Buffer.from(expected, "utf8")
  // timingSafeEqual needs equal lengths. A MAC's length is public, so only its content must not leak through timing.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

/** A header value fit to show: printable ASCII, at most 100 characters. */
function printable(value: string | null): string | null {
  if (value === null) return null
  const clean = value.replace(/[^\x20-\x7e]/g, "").slice(0, 100)
  return clean === "" ? null : clean
}
