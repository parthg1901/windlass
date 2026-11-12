/**
 * Review finding: the bound on stop hooks starts again whenever a harness message is delivered in the middle
 * of the turn, so a turn can be sent back more often than `maxStopRounds`.
 *
 * What is promised.
 * - docs/hooks.md, "The bound on stop hooks": "Stop hooks send the agent back at most `maxStopRounds` times in
 *   one turn. The last message says so [...] and if the hook still objects after that, the turn ends anyway".
 * - packages/core/src/hooks/decide.ts: "at most `maxStopRounds` times per turn. After that the turn ends, and
 *   says the hook was not satisfied. It never loops."
 *
 * What happens. The rounds are counted with `stopRoundsSent(currentTurn(state))`, and `currentTurn` starts at
 * the latest message that came out of the inbox. A user's prompt is one, but so is every message the harness
 * itself delivers: the end of a background command, a watch that fired, a background subagent's result. When
 * one arrives after a stop hook sent the model back, the earlier stop messages fall out of the count: the next
 * objection is again "[Stop hook 1 of at most N]", and it again says "This is the last time". A model that
 * starts something in the background in each round (a test run, to satisfy a hook that wants green tests) is
 * never held to the bound; only the step limit ends the turn, and that count starts again the same way.
 *
 * Code path. `LiveSession.finish` in packages/core/src/engine/engine.ts (`stopRoundsSent(currentTurn(state))`);
 * `currentTurn` and `delivered` in packages/core/src/engine/state.ts.
 *
 * Smallest fix. Count the stop-hook messages since the latest input of a person (a user message, or the start
 * of the execution), not since the latest delivered message of any origin: in `finish`, pass
 * `stopRoundsSent` the messages after the last `kind === "user"` message under the claim.
 *
 * What that fix could affect. A user's steer in the middle of a turn would still start the count again, which
 * matches "one turn" as a person sees it. A wake-up's message, which starts a turn of its own, should keep
 * counting as a start. `stepsThisTurn` uses the same `currentTurn`; this change would not touch it.
 */
import { afterAll, expect, test } from "bun:test"
import { HARNESS_ORIGIN, type StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolContext } from "../../src/tool/tool.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
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

test.failing("a stop hook should send the model back at most maxStopRounds times in one turn, also when a background command ends in between", async () => {
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
