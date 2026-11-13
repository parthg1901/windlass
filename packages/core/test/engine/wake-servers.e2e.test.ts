/**
 * Several long-lived harness processes on one data directory, each told to
 * fire wake-ups, as several `acp` servers are when an editor and a terminal
 * interface run at once: every firing is delivered by exactly one of them,
 * the webhook listener's port belongs to whichever bound it first, and none
 * of them is disturbed by the others.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import { resolveConfig } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { signWebhook } from "../../src/wake/webhook.ts"

const SERVER = join(import.meta.dir, "fixtures", "wake-server.ts")
const made: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
afterAll(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A port nothing listens on right now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))))
    })
  })

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

describe("several servers that fire wake-ups", () => {
  test("a timer and a webhook: each fires once, in one of them, and both servers stay up and shut down cleanly", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-wake-servers-")))
    made.push(root)
    const dataDir = join(root, "data")
    const cwd = join(root, "repo")
    mkdirSync(cwd, { recursive: true })
    const port = await freePort()

    // A process that only sets wake-ups up, as a one-prompt run does: it fires nothing itself.
    const setup = createHarness({
      dataDir,
      provider: new FakeProvider([[script.text("Hello.")]]),
      log: () => {},
      engine: { wake: { port }, loadConfig: async (directory) => ({ config: resolveConfig({}), projectDir: directory }), snapshots: null, approval: null },
    })
    const session = setup.engine.createSession({ cwd, settings: { model: "m", reasoningEffort: null } })
    session.send("Hi.")
    await session.settled()
    const id = session.id
    const wakes = setup.engine.wake()!
    expect(wakes.running).toBe(false)
    const timer = wakes.store.create({ sessionId: id, message: "The timer came due.", author: "user", trigger: { kind: "after", delayMs: 1200 } })
    const hook = wakes.store.create({ sessionId: id, message: "The hook was called.", author: "user", trigger: { kind: "webhook" } })
    if (!timer.ok || !hook.ok) throw new Error("the wake-ups could not be created")
    // The session is let go of, so that whichever server fires can open it.
    await session.close()

    const servers = [0, 1].map(() => {
      const child = Bun.spawn([process.execPath, SERVER, dataDir, String(port)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      children.push(child)
      return child
    })
    const read = (stream: ReadableStream<Uint8Array>) => {
      let text = ""
      void (async () => {
        const decoder = new TextDecoder()
        for await (const chunk of stream) text += decoder.decode(chunk)
      })()
      return () => text
    }
    const outputs = servers.map((child) => ({ out: read(child.stdout as ReadableStream<Uint8Array>), err: read(child.stderr as ReadableStream<Uint8Array>) }))
    await until("both servers to start", () => outputs.every((output) => output.out().includes("ready")))

    const log = (): readonly StoredEvent[] => setup.engine.readEvents(id)
    const firings = (origin: string) => log().filter((item) => item.type === "inbox.enqueued" && item.data.origin === origin)
    const turnsDone = () => log().filter((item) => item.type === "execution.succeeded").length

    // The timer: delivered once, by one of the two, and its turn runs there.
    await until("the timer's turn", () => firings("wake").length === 1 && turnsDone() === 2)
    await Bun.sleep(600)
    expect(firings("wake")).toHaveLength(1)
    expect(wakes.store.get(timer.wake.id)!.state.kind).toBe("completed")

    // The webhook: both servers want the port, one has it; a signed request is recorded once and fired once.
    const body = JSON.stringify({ ref: "refs/heads/main" })
    const send = () => fetch(`http://127.0.0.1:${port}/w/${hook.wake.id}`, { method: "POST", headers: { "content-type": "application/json", ...signWebhook(hook.secret!, body, Math.floor(Date.now() / 1000)) }, body })
    await until("the listener", async () => (await send().then((response) => response.status, () => 0)) === 202, 40_000)
    await until("the webhook's turn", () => firings("wake_webhook").length >= 1 && turnsDone() >= 3)
    await Bun.sleep(600)
    expect(firings("wake_webhook")).toHaveLength(1)
    expect(turnsDone()).toBe(3)

    // Neither server crashed, and both shut down as a server does when its client goes away.
    for (const child of servers) expect(child.exitCode).toBeNull()
    for (const child of servers) (child.stdin as { end: () => void }).end()
    expect(await Promise.all(servers.map((child) => child.exited))).toEqual([0, 0])
    for (const output of outputs) expect(output.err()).not.toMatch(/error|EADDRINUSE|unhandled/i)
    // Exactly one of them answered each wake-up's turn.
    const answers = setup.engine.readEvents(id).flatMap((item) => (item.type === "text.ended" ? [item.data.text] : []))
    expect(answers).toHaveLength(3)
    expect(answers.slice(1).every((text) => /^Handled by \d+\.$/.test(text))).toBe(true)
    await setup.close()
  }, 120_000)
})
