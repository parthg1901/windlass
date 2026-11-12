/**
 * The bound on stop hooks holds for the whole turn.
 *
 * docs/hooks.md, "The bound on stop hooks": "Stop hooks send the agent back at most `maxStopRounds` times in one
 * turn. The last message says so [...] and if the hook still objects after that, the turn ends anyway".
 *
 * The rounds are counted from the log over the turn as a person sees it (`wholeTurn` in engine/state.ts): since
 * the user's message, or the queued item, that began it. A message the harness itself delivers in the middle of
 * the turn (the end of a background command, a watch that fired, a background subagent's result) does not start
 * the count again, so a model that starts something in the background in every round is still held to the bound.
 * A user's next message does start it again: that is another turn.
 */
import { afterAll, expect, test } from "bun:test"
import { HARNESS_ORIGIN, type StoredEvent } from "../../src/event/durable.ts"
import type { MessageId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolContext } from "../../src/tool/tool.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]

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

test("a stop hook should send the model back at most maxStopRounds times in one turn, also when a background command ends in between", async () => {
  const scripted = scriptedRunner({ never: exited(2, "Not yet.\n") })
  const h = new Harness({ spawn: {}, userConfig: { verify: { mode: "off" }, hooks: { stop: [{ name: "never", command: "exit 2" }], maxStopRounds: 1 } }, hooks: { runner: scripted.runner } })
  try {
    const command = backgroundCommand("sleep 1")
    h.tools.on("shell", command.start)
    h.provider.enqueue([call("shell", { command: "sleep 1", background: true }), U], answer("Done."), answer("Done again."), answer("The command ended."), answer("Done, really."))
    // Boundaries: before step 1, before step 2, before the hook is first asked, and the fourth is the first one
    // after the stop hook sent the model back. The command ends there, so its end is delivered later in the same turn.
    h.at("step.boundary", 4, () => command.exit(0))
    h.create().send("Work.")
    await h.settled()

    const log = h.log()
    // One prompt, one execution: one turn.
    expect(log.filter((item) => item.type === "execution.started")).toHaveLength(1)
    expect(log.filter((item) => item.type === "inbox.enqueued" && item.data.origin === HARNESS_ORIGIN.backgroundCommand)).toHaveLength(1)
    const sentBack = log.filter((item): item is StoredEvent<"synthetic.appended"> => item.type === "synthetic.appended" && item.data.origin === HARNESS_ORIGIN.stopHook)
    // With maxStopRounds 1 the model is sent back once; the next objection ends the turn with the hook unsatisfied.
    expect(sentBack).toHaveLength(1)
    const ending = log.find((item): item is StoredEvent<"execution.succeeded"> => item.type === "execution.succeeded")
    expect(ending?.data.hooks?.unsatisfied).toEqual(["never"])
  } finally {
    await h.dispose()
  }
})

test("the count starts again with the user's next message: each turn has its own rounds", async () => {
  const scripted = scriptedRunner({ never: exited(2, "Not yet.\n") })
  const h = new Harness({ userConfig: { verify: { mode: "off" }, hooks: { stop: [{ name: "never", command: "exit 2" }], maxStopRounds: 1 } }, hooks: { runner: scripted.runner } })
  try {
    h.provider.enqueue(answer("Done."), answer("Done again."), answer("Second."), answer("Second again."))
    h.create().send("Work.")
    await h.settled()
    h.session.send("More work.")
    await h.settled()
    const sentBack = h.log().filter((item): item is StoredEvent<"synthetic.appended"> => item.type === "synthetic.appended" && item.data.origin === HARNESS_ORIGIN.stopHook)
    // Once in each turn, and each turn then ends with the hook unsatisfied.
    expect(sentBack).toHaveLength(2)
    expect(h.log().filter((item): item is StoredEvent<"execution.succeeded"> => item.type === "execution.succeeded").map((item) => item.data.hooks?.unsatisfied)).toEqual([["never"], ["never"]])
  } finally {
    await h.dispose()
  }
})

test("a queued message of the harness's (a wake-up's) begins a turn of its own under the same claim, with rounds of its own", async () => {
  const scripted = scriptedRunner({ never: exited(2, "Not yet.\n") })
  const h = new Harness({ userConfig: { verify: { mode: "off" }, hooks: { stop: [{ name: "never", command: "exit 2" }], maxStopRounds: 1 } }, hooks: { runner: scripted.runner } })
  try {
    h.provider.enqueue(answer("Done."), answer("Done again."), answer("Woken."), answer("Woken again."))
    h.create().send("Work.")
    // Admitted while the first turn runs: it waits for that turn to end, then is delivered under the same claim.
    h.at("step.boundary", 2, () => void h.session.admit({ messageId: "msg_wake_1" as MessageId, origin: "wake", text: "The build is done.", start: false }))
    await h.settled()
    const log = h.log()
    expect(log.filter((item) => item.type === "execution.started")).toHaveLength(1)
    expect(log.filter((item) => item.type === "turn.ended")).toHaveLength(1)
    const sentBack = log.filter((item): item is StoredEvent<"synthetic.appended"> => item.type === "synthetic.appended" && item.data.origin === HARNESS_ORIGIN.stopHook)
    expect(sentBack).toHaveLength(2)
  } finally {
    await h.dispose()
  }
})
