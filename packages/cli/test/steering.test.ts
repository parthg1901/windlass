/**
 * Input while a turn runs: the fake engine admits it at once and delivers it
 * where the step loop would, and every log it writes is one the reducer
 * accepts. Then the same through the interactive CLI.
 */
import { describe, expect, test } from "bun:test"
import type { NewEvent, StoredEvent } from "@windlass/core"
import { fold } from "@windlass/core/testing/scenarios"
import { findScenario } from "../src/demo/scenarios.ts"
import type { EngineEvent } from "../src/engine.ts"
import { FakeEngine, type FakeSession } from "../src/fake-engine.ts"
import { runCli } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"
import { waitFor as waitUntil } from "@windlass/core/testing"

const durable = (item: EngineEvent): item is StoredEvent => "seq" in item
const strip = (item: StoredEvent): NewEvent => ({ type: item.type, v: item.v, data: item.data }) as NewEvent
const ends = (item: EngineEvent) => item.type === "execution.succeeded" || item.type === "execution.failed" || item.type === "execution.interrupted"

/** Opens a scenario at high speed. `on` sees every event and may act on the session; the session ends after `turns` turns. */
async function play(name: string, on: (item: EngineEvent, session: FakeSession) => void, turns = 1) {
  const engine = new FakeEngine(findScenario(name)!.scenario, { speed: 25, graceMs: 50 })
  const session = await engine.open({ session: { kind: "new" }, cwd: "/repo", model: null, effort: null, maxSteps: null })
  const log: StoredEvent[] = []
  await session.send("")
  let ended = 0
  for await (const item of session.events) {
    if (durable(item)) log.push(item)
    on(item, session)
    if (ends(item) && ++ended === turns) break
  }
  await session.close()
  const state = fold(null, log.map(strip))
  return { log, types: log.map((item) => label(item)), state }
}

function label(item: StoredEvent): string {
  switch (item.type) {
    case "inbox.enqueued":
      return `enqueued ${item.data.messageId} ${item.data.delivery}`
    case "inbox.delivered":
      return `delivered ${item.data.messageId}`
    case "step.started":
      return `step ${item.data.messageId}`
    default:
      return item.type
  }
}

const once = (when: (item: EngineEvent) => boolean, act: (session: FakeSession) => void) => {
  let done = false
  return (item: EngineEvent, session: FakeSession) => {
    if (done || !when(item)) return
    done = true
    act(session)
  }
}

describe("the fake engine takes input during a turn", () => {
  test("a steer is admitted at once and delivered at the next step boundary, where the script's next step answers it", async () => {
    const { types, state } = await play("one-tool-call-then-an-answer", once((item) => item.type === "tool.started", (session) => void session.send("Also check b.ts.")))
    const admitted = types.indexOf("enqueued u_live_1 steer")
    expect(types[admitted - 1]).toBe("tool.started")
    expect(types.slice(types.indexOf("delivered u_live_1") - 1, types.indexOf("delivered u_live_1") + 2)).toEqual(["step.ended", "delivered u_live_1", "step a2"])
    expect(types.at(-1)).toBe("execution.succeeded")
    expect(state.inbox).toEqual([])
  })

  test("a queued message waits for the answer, then is delivered and answered under the same claim", async () => {
    const { types, state } = await play("one-tool-call-then-an-answer", once((item) => item.type === "tool.started", (session) => void session.send("Then a changelog entry.", { delivery: "queue" })))
    // The turn ends first (a replay verifies nothing), then the queued message is delivered.
    expect(types.slice(-7)).toEqual(["step.ended", "turn.ended", "delivered u_live_1", "step a_live_2", "text.ended", "step.ended", "execution.succeeded"])
    expect(state.messages.find((message) => String(message.id) === "a_live_2")?.kind).toBe("assistant")
  })

  test("a steer during the final answer gets an answer before the session goes idle", async () => {
    const { types } = await play("a-plain-answer", once((item) => item.type === "text.delta", (session) => void session.send("And the tests?")))
    expect(types.slice(-6)).toEqual(["step.ended", "delivered u_live_1", "step a_live_2", "text.ended", "step.ended", "execution.succeeded"])
  })

  test("a steer that is waiting when the user stops survives, and is delivered first when work starts again", async () => {
    let next = 0
    const { types, state } = await play(
      "a-long-build-command",
      (item, session) => {
        if (item.type === "tool.progress" && next === 0) {
          next = 1
          void session.send("Use the fast suite.")
          session.interrupt()
        }
        if (item.type === "execution.interrupted" && next === 1) {
          next = 2
          void session.send("Try again.")
        }
      },
      2,
    )
    const interrupted = types.indexOf("execution.interrupted")
    expect(types.slice(interrupted + 1, interrupted + 5)).toEqual(["enqueued u_demo_1 steer", "execution.started", "delivered u_live_1", "delivered u_demo_1"])
    expect(state.inbox).toEqual([])
  })

  test("close stops a running turn as a shutdown, which keeps the claim", async () => {
    const { types, state } = await play("a-long-build-command", once((item) => item.type === "tool.progress", (session) => void session.close()))
    expect(types.slice(-5)).toEqual(["execution.interrupt_requested", "tool.settled", "step.failed", "synthetic.appended", "execution.interrupted"])
    expect(state.session.execution?.status).toBe("suspended")
  })

  test("a stop asked for before the execution exists takes effect as soon as it does", async () => {
    const engine = new FakeEngine(findScenario("a-plain-answer")!.scenario, { speed: 25 })
    const session = await engine.open({ session: { kind: "new" }, cwd: "/repo", model: null, effort: null, maxSteps: null })
    await session.send("")
    session.interrupt()
    const log: StoredEvent[] = []
    for await (const item of session.events) {
      if (durable(item)) log.push(item)
      if (ends(item)) break
    }
    await session.close()
    expect(log.map((item) => item.type).slice(-4)).toEqual(["execution.started", "execution.interrupt_requested", "synthetic.appended", "execution.interrupted"])
    expect(fold(null, log.map(strip)).session.execution).toBeNull()
  })

  test("turns the fake makes up call the session's current model", async () => {
    const { state } = await play("the-user-switches-the-model-in-the-middle-of-a-turn", once(ends, (session) => void session.send("More?")), 2)
    expect(state.session.settings.model).toBe("gpt-other")
    expect(String(state.messages.at(-1)?.id)).toBe("a_demo_1")
  })
})

describe("the interactive CLI", () => {
  /** Runs an interactive demo; `script` types into it, waiting for output first. */
  async function interactive(name: string, script: (type: (keys: string) => void, waitFor: (needle: string | RegExp) => Promise<void>) => Promise<void>) {
    let typer: ((data: string) => void) | null = null
    let seen = ""
    const vt = new VirtualTerminal(80)
    const waitFor = async (needle: string | RegExp): Promise<void> => {
      await waitUntil(() => (typeof needle === "string" ? seen.includes(needle) : needle.test(seen)), { timeoutMs: 10_000, intervalMs: 5, what: String(needle), describe: () => `\n${vt.text}\n${JSON.stringify(seen.slice(-400))}` })
    }
    const running = runCli(["--demo", name, "--demo-speed", "8", "-i"], {
      stdinTTY: true,
      stdoutTTY: true,
      env: { NO_COLOR: "1" },
      keys: (type) => {
        typer = type
      },
      onWrite: (text) => {
        seen += text
        vt.write(text)
      },
    })
    await waitFor("›")
    await script((keys) => typer!(keys), waitFor)
    const result = await running
    return { ...result, screen: vt.text }
  }

  test("text typed while the agent works is sent at once and its delivery shown; /queue holds it for after the turn", async () => {
    const result = await interactive("one-tool-call-then-an-answer", async (type, waitFor) => {
      type("Fix it\r")
      await waitFor("▸ read")
      type("Also check b.ts.\r")
      await waitFor('↳ sent: "Also check b.ts."')
      type("/queue Then the changelog.\r")
      await waitFor("✓ done")
      type("\x04")
    })
    expect(result.code).toBe(0)
    const lines = result.screen.split("\n")
    const at = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix))
    expect(lines[0]).toBe("› Fix it")
    expect(lines[at("↳ sent:")]).toBe('↳ sent: "Also check b.ts." · the agent will see it after the current step')
    expect(lines[at("↳ queued:")]).toBe('↳ queued: "Then the changelog." · the agent will see it after this turn')
    expect(at('↳ delivered to the agent: "Also check b.ts."')).toBeGreaterThan(at("↳ queued:"))
    expect(at('↳ delivered to the agent: "Then the changelog."')).toBeGreaterThan(at('↳ delivered to the agent: "Also check b.ts."'))
    expect(result.screen).toContain('Got "Then the changelog.". This is a scripted demo')
    // The footer is gone and the terminal is back to normal mode.
    expect(lines.at(-1)).toBe("  tokens · 3,200 in · 2,624 cached (82%) · 130 out (20 reasoning)")
    expect(result.out.endsWith("\x1b[?2004l")).toBe(true)
  }, 20_000)

  test("Up recalls the previous entry whole, and /exit leaves", async () => {
    const result = await interactive("a-plain-answer", async (type, waitFor) => {
      type("What does\x1b\rthis repo do?\r")
      // The prompt is back after the turn's outcome, so the key goes to it.
      await waitFor(/✓ done[\s\S]*›/)
      type("\x1b[A")
      await waitFor("  this repo do?")
      type("\x03/exit\r")
    })
    expect(result.code).toBe(0)
    expect(result.screen.startsWith("› What does\n  this repo do?\n")).toBe(true)
  }, 20_000)
})
