/**
 * A captured webhook request can be accepted a second time by sending the same signature without its `v1=` (or
 * `sha256=`) prefix.
 *
 * Promise. docs/wake-ups.md, "Webhooks": the native scheme is "valid for five minutes and once"; GitHub's: "each
 * signature is accepted once for the life of the wake-up: a resent delivery, or a captured request replayed later,
 * is refused" (packages/core/src/wake/webhook.ts, the module comment). "Every request that ... was already used ...
 * gets the same answer" (401).
 *
 * What happens. The signature is checked after stripping an optional prefix
 * (`native.replace(/^v1=/, "")`, `github.replace(/^sha256=/, "")`), but what is remembered as used is the header
 * as sent (`digest = \`v1:${native}\``, `digest = \`gh:${github}\``). `v1=<hex>` and `<hex>` are the same signature
 * and two different digests, so each captured request fires the wake-up twice: once as sent and once without the
 * prefix (after the wake-up's minimum interval). Each firing is a turn in the session, unattended, with the body as
 * untrusted content.
 *
 * Code path. packages/core/src/wake/webhook.ts `createWebhookListener` → `handle`: the `native !== null` and
 * `github !== null` branches.
 *
 * Smallest fix. Remember the digest of the normalised signature (`v1:${hex}`, `gh:${hex}`, lowercased), or require
 * the prefix (refuse a header without `v1=` / `sha256=`, as GitHub always sends it).
 *
 * What else the fix affects. Nothing that is accepted once today is refused, apart from the second copy; replays
 * already recorded under the old digest stay recorded under it (a signature seen before the change could be
 * accepted once more after it, once).
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWakeStore } from "../../src/wake/store.ts"
import { GITHUB_SIGNATURE_HEADER, SIGNATURE_HEADER, createWebhookListener, signGithubStyle, signWebhook } from "../../src/wake/webhook.ts"
import { SECOND, manualClock } from "../wake/helpers.ts"

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

test.failing("a native request replayed with its signature's v1= prefix taken off is refused as already used", async () => {
  const { clock, post, close, secret } = listening()
  try {
    const headers = signWebhook(secret, BODY, Math.floor(clock.now() / 1000))
    expect(await post(headers, BODY)).toBe(202)
    clock.advance(11 * SECOND)
    // Today: 202, a second firing.
    expect(await post({ ...headers, [SIGNATURE_HEADER]: headers[SIGNATURE_HEADER]!.replace(/^v1=/, "") }, BODY)).toBe(401)
  } finally {
    await close()
  }
})

test.failing("a GitHub-style request replayed with its signature's sha256= prefix taken off is refused as already used", async () => {
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
