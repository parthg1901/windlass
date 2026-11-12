/**
 * A webhook signature is accepted once (docs/wake-ups.md, "Webhooks": the native scheme is "valid for five minutes
 * and once"; GitHub's signature is accepted once for the life of the wake-up). Once means of the signature, however
 * the header writes it: with or without its `v1=` / `sha256=` prefix, with whitespace around it. Forms that are not
 * accepted at all (uppercase hex, two signatures in one header) stay refused and do not fire it a second time.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWakeStore } from "../../src/wake/store.ts"
import { GITHUB_SIGNATURE_HEADER, SIGNATURE_HEADER, createWebhookListener, signGithubStyle, signWebhook } from "../../src/wake/webhook.ts"
import { SECOND, manualClock } from "./helpers.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function listening() {
  const dir = mkdtempSync(join(tmpdir(), "review-webhook-"))
  directories.push(dir)
  const clock = manualClock()
  const store = openWakeStore({ dir, clock })
  const created = store.create({ sessionId: "ses_1", message: "A deploy finished; check it.", author: "user", trigger: { kind: "webhook" }, minIntervalMs: 10 * SECOND })
  if (!created.ok) throw new Error(created.error)
  const listener = createWebhookListener({ store, clock, port: 0 })
  if (!listener.refresh()) throw new Error("the listener did not start")
  const post = async (headers: Record<string, string>, body: string) => {
    const response = await fetch(`${listener.url()}/w/${created.wake.id}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } })
    await response.text()
    return response.status
  }
  const close = async () => {
    await listener.stop()
    store.close()
  }
  return { clock, post, close, secret: created.secret! }
}

const BODY = '{"service":"api","status":"deployed"}'

test("control: the same native request sent twice is accepted once", async () => {
  const { clock, post, close, secret } = listening()
  try {
    const headers = signWebhook(secret, BODY, Math.floor(clock.now() / 1000))
    expect(await post(headers, BODY)).toBe(202)
    clock.advance(11 * SECOND)
    expect(await post(headers, BODY)).toBe(401)
  } finally {
    await close()
  }
})

test("a native request replayed with its signature's v1= prefix taken off is refused as already used", async () => {
  const { clock, post, close, secret } = listening()
  try {
    const headers = signWebhook(secret, BODY, Math.floor(clock.now() / 1000))
    expect(await post(headers, BODY)).toBe(202)
    clock.advance(11 * SECOND)
    expect(await post({ ...headers, [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER]!.replace(/^v1=/, "") }, BODY)).toBe(401)
  } finally {
    await close()
  }
})

test("a GitHub-style request replayed with its signature's sha256= prefix taken off is refused as already used", async () => {
  const { clock, post, close, secret } = listening()
  try {
    const headers = signGithubStyle(secret, BODY)
    expect(await post(headers, BODY)).toBe(202)
    clock.advance(11 * SECOND)
    expect(await post({ [GITHUB_SIGNATURE_HEADER]: headers[GITHUB_SIGNATURE_HEADER]!.replace(/^sha256=/, "") }, BODY)).toBe(401)
  } finally {
    await close()
  }
})

/** The two schemes: sign a body, and the header that carries the signature. */
const SCHEMES = [
  { name: "native", header: SIGNATURE_HEADER, prefix: "v1=", sign: (secret: string, now: number) => signWebhook(secret, BODY, Math.floor(now / 1000)) },
  { name: "GitHub-style", header: GITHUB_SIGNATURE_HEADER, prefix: "sha256=", sign: (secret: string) => signGithubStyle(secret, BODY) },
] as const

for (const scheme of SCHEMES) {
  /** The signed headers with the signature written another way. */
  const rewritten = (headers: Record<string, string>, write: (hex: string) => string) => ({ ...headers, [scheme.header]: write(headers[scheme.header]!.slice(scheme.prefix.length)) })

  test(`${scheme.name}: a signature first sent without its prefix is refused when replayed with it`, async () => {
    const { clock, post, close, secret } = listening()
    try {
      const headers = scheme.sign(secret, clock.now())
      expect(await post(rewritten(headers, (hex) => hex), BODY)).toBe(202)
      clock.advance(11 * SECOND)
      expect(await post(headers, BODY)).toBe(401)
    } finally {
      await close()
    }
  })

  test(`${scheme.name}: whitespace around the signature does not make it another one`, async () => {
    const { clock, post, close, secret } = listening()
    try {
      const headers = scheme.sign(secret, clock.now())
      expect(await post(headers, BODY)).toBe(202)
      clock.advance(11 * SECOND)
      expect(await post(rewritten(headers, (hex) => ` \t${scheme.prefix}${hex}  `), BODY)).toBe(401)
      expect(await post(rewritten(headers, (hex) => ` ${hex} `), BODY)).toBe(401)
    } finally {
      await close()
    }
  })

  test(`${scheme.name}: forms that are not accepted (uppercase hex, two signatures in one header) never fire it again`, async () => {
    const { clock, post, close, secret } = listening()
    try {
      const headers = scheme.sign(secret, clock.now())
      expect(await post(headers, BODY)).toBe(202)
      clock.advance(11 * SECOND)
      expect(await post(rewritten(headers, (hex) => `${scheme.prefix}${hex.toUpperCase()}`), BODY)).toBe(401)
      expect(await post(rewritten(headers, (hex) => `${scheme.prefix.toUpperCase()}${hex}`), BODY)).toBe(401)
      expect(await post(rewritten(headers, (hex) => `${scheme.prefix}${hex}, ${scheme.prefix}${"0".repeat(64)}`), BODY)).toBe(401)
      expect(await post(rewritten(headers, (hex) => `${scheme.prefix}${"0".repeat(64)} ${scheme.prefix}${hex}`), BODY)).toBe(401)
    } finally {
      await close()
    }
  })

  test(`${scheme.name}: an uppercase signature is refused even when it is the first`, async () => {
    const { clock, post, close, secret } = listening()
    try {
      const headers = scheme.sign(secret, clock.now())
      expect(await post(rewritten(headers, (hex) => `${scheme.prefix}${hex.toUpperCase()}`), BODY)).toBe(401)
      // It used nothing up: the signature as written by the signer is still accepted, once.
      expect(await post(headers, BODY)).toBe(202)
    } finally {
      await close()
    }
  })
}

test("a new signature of the same body is still accepted: what is remembered is the signature, not the body", async () => {
  const { clock, post, close, secret } = listening()
  try {
    expect(await post(signWebhook(secret, BODY, Math.floor(clock.now() / 1000)), BODY)).toBe(202)
    clock.advance(11 * SECOND)
    expect(await post(signWebhook(secret, BODY, Math.floor(clock.now() / 1000)), BODY)).toBe(202)
  } finally {
    await close()
  }
})
