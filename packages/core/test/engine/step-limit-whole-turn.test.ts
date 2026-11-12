/**
 * The step limit holds for the whole turn.
 *
 * A turn's steps are counted from the log over the turn as a person sees it (`wholeTurn` in engine/state.ts):
 * since the user's message, or the queued item, that began it. A message the harness itself delivers in the
 * middle of the turn (the end of a background command, a watch that fired, a background subagent's result) does
 * not start the count again, so a model that keeps something running in the background is still held to the
 * limit, and the limit a caller gave with the turn's input (`send(text, { maxSteps })`) stays the turn's.
 */
import { afterAll, expect, test } from "bun:test"
import { HARNESS_ORIGIN, type StoredEvent } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolContext } from "../../src/tool/tool.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const limitNotes = (log: readonly StoredEvent[]) => log.filter((item) => item.type === "synthetic.appended" && item.data.origin === HARNESS_ORIGIN.stepLimit)

/** A background command as the scripted shell tool hands it to the session: it runs until the test ends it. */
function backgroundCommand(command: string) {
  let end: (result: { exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; output: string }) => void = () => {}
  const ended = new Promise<Parameters<typeof end>[0]>((resolve) => (end = resolve))
  const exit = (exitCode: number | null) => end({ exitCode, signal: exitCode === null ? "SIGTERM" : null, timedOut: false, durationMs: 1000, output: "" })
  return {
    start: (_input: Record<string, unknown>, context: ToolContext) => `Started in the background as ${context.background!.command({ command, logPath: null, stop: async () => exit(null), output: () => "", exited: ended }).id}.`,
    exit,
  }
}

test("the steps of a turn should be counted from the input that began it, also when a background command ends in between", async () => {
  const h = new Harness({ spawn: {}, userConfig: { verify: { mode: "off" } } })
  try {
    const command = backgroundCommand("sleep 1")
    h.tools.on("shell", command.start)
    h.tools.on("read", "1")
    h.provider.enqueue([call("shell", { command: "sleep 1", background: true }), U], [call("read", { path: "1.ts" }, "call_2"), U], answer("Two steps made; the rest is left."))
    // The command ends while the turn runs, so its end is delivered in the middle of the turn.
    h.at("step.boundary", 2, () => command.exit(0))
    h.create().send("Work.", { maxSteps: 2 })
    await h.settled()

    const log = h.log()
    expect(log.filter((item) => item.type === "execution.started")).toHaveLength(1)
    const delivered = log.filter((item) => item.type === "inbox.enqueued" && item.data.origin === HARNESS_ORIGIN.backgroundCommand)
    expect(delivered).toHaveLength(1)
    // Two steps were made under the turn's limit of two: the third call is the last and may not use tools.
    expect(limitNotes(log)).toHaveLength(1)
    expect(limitNotes(log)[0]!.seq).toBeGreaterThan(delivered[0]!.seq)
    expect(h.provider.calls).toHaveLength(3)
    expect(h.provider.calls.map((call) => call.request.toolChoice)).toEqual(["auto", "auto", "none"])
    expect(log.at(-1)?.type).toBe("execution.succeeded")
    expect(h.provider.prefixBreaks()).toEqual([])
  } finally {
    await h.dispose()
  }
})

test("a queued message of the harness's begins a turn of its own, with steps of its own", async () => {
  const h = new Harness({ userConfig: { verify: { mode: "off" } }, limits: { stepLimit: 2 } })
  try {
    h.tools.on("read", "1", "2")
    h.provider.enqueue([call("read", { path: "1.ts" }), U], answer("Read."), [call("read", { path: "2.ts" }, "call_2"), U], answer("Woken and read."))
    h.create().send("Work.")
    // Admitted while the first turn runs: it waits for that turn to end, then is delivered under the same claim.
    h.at("step.boundary", 2, () => void h.session.admit({ messageId: "msg_wake_1" as MessageId, origin: "wake", text: "The build is done.", start: false }))
    await h.settled()
    const log = h.log()
    expect(log.filter((item) => item.type === "execution.started")).toHaveLength(1)
    expect(log.filter((item) => item.type === "turn.ended")).toHaveLength(1)
    // Two steps in each turn, four under the claim: neither turn reached past its limit's final call.
    expect(h.tools.ran).toHaveLength(2)
    expect(log.at(-1)?.type).toBe("execution.succeeded")
  } finally {
    await h.dispose()
  }
})
