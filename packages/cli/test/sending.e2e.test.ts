/**
 * What is typed after a prompt's Enter and before the prompt has reached the engine (the CLI first reads the
 * project's hooks and servers, and may ask about them): it goes after the prompt, never ahead of it. Sent ahead,
 * a `/queue` message started the turn itself, the prompt arrived as a steer into it, and neither was said as what
 * it was.
 */
import { describe, expect, test, setDefaultTimeout } from "bun:test"
import { brand } from "@windlass/core"
import { E2E_TIMEOUT_MS, FakeProvider, script } from "@windlass/core/testing"
import type { Engine, Session } from "../src/engine.ts"
import { typedSessions } from "./typed.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

describe("typed while the prompt is on its way", () => {
  const { workspace, engineFor, interactive } = typedSessions(`${brand.binary}-cli-sending-`)

  /** The engine with a session whose look at the project's hooks takes a moment, as it can under load. */
  const slow = (engine: () => Engine) => () => {
    const inner = engine()
    return {
      ...inner,
      open: async (request: Parameters<Engine["open"]>[0]) => {
        const session = await inner.open(request)
        const hooks = session.hooks
        if (hooks !== undefined) session.hooks = async () => (await Bun.sleep(400), hooks.call(session))
        return session as Session
      },
    } as Engine
  }

  test("a /queue message typed then is queued behind the prompt, and the prompt starts the turn", async () => {
    const cwd = workspace()
    const provider = new FakeProvider([[script.text("First done.")], [script.text("Second done.")]])
    const run = await interactive(["--cwd", cwd], slow(engineFor(provider, cwd)), async (type, waitFor) => {
      type("first message\r")
      await waitFor("› first message")
      type("/queue second message\r")
      await waitFor("Second done.")
      await waitFor(/✓ done[\s\S]*›/)
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.screen).toContain('↳ queued: "second message"')
    expect(run.screen).not.toContain('↳ sent: "first message"')
    // The prompt was the first request's message; the queued one came after its turn.
    expect(JSON.stringify(provider.requests[0]!.input)).toContain("first message")
    expect(JSON.stringify(provider.requests[0]!.input)).not.toContain("second message")
    expect(JSON.stringify(provider.requests[1]!.input)).toContain("second message")
  })
})

describe("a prompt given with -i", () => {
  const { workspace, engineFor, interactive } = typedSessions(`${brand.binary}-cli-first-`)

  test("is shown as one typed at the prompt would be, once", async () => {
    const cwd = workspace()
    const provider = new FakeProvider([[script.text("Hello back.")]])
    const run = await interactive(["--cwd", cwd, "-i", "hello there"], engineFor(provider, cwd), async (type, waitFor) => {
      await waitFor("Hello back.")
      await waitFor(/✓ done[\s\S]*›/)
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.screen.split("› hello there")).toHaveLength(2)
    expect(run.screen.indexOf("› hello there")).toBeLessThan(run.screen.indexOf("Hello back."))
  })
})
