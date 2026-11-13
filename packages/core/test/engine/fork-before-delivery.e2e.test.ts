/**
 * A fork made between a message's `inbox.enqueued` and its `inbox.delivered`
 * is a fork without that message.
 *
 * `forkSession` (`engine.ts`) folds the parent's log to `throughSeq` and
 * accepts the point when nothing is open; the reducer's `create`
 * (`message/reducer.ts`) checks the same thing ("a fork point must be a step
 * boundary") and gives the fork an empty inbox. Between an `inbox.enqueued`
 * and its `inbox.delivered` only the claim, the baseline, a delivery
 * snapshot and appended instructions are written; no step or compaction is
 * open. So every point in that window is a legal boundary, and the
 * contract's "what it does not inherit: the inbox, the claim" applies: the
 * message is not lost (it stays in the parent's inbox and the parent
 * delivers it), it was never the fork's.
 *
 * The engine gives the fork the parent's `session.title` as of the fork
 * point (`null` when nobody named it), and its summary's `firstPrompt` is
 * the first user message among its own rows, so a fork made before the
 * first prompt was delivered is not named after a prompt it does not have.
 * (The inherited log does hold the enqueue: a client that derives a title
 * from the first `inbox.enqueued` of the log, delivered or not, names the
 * fork after it.)
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import { SETTINGS, closeHarnesses, place, removePlaces, say, start } from "./assembly-helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(closeHarnesses)
afterAll(removePlaces)

const texts = (events: readonly StoredEvent[]) => events.flatMap((item) => (item.type === "inbox.enqueued" ? item.data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))

describe("a fork between a message's enqueue and its delivery", () => {
  test("every point in that window is a boundary; the fork has neither the message nor an inbox, and the parent still delivers it", async () => {
    const { data, workspace } = place("wl-fork-window-")
    const { harness } = start(data, [say("One."), say("Two."), ...Array.from({ length: 12 }, () => say("In the fork."))])
    const engine = harness.engine
    const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS })
    parent.send("First question.")
    await parent.settled()
    parent.send("Second question.")
    await parent.settled()
    const log = parent.readEvents()
    const second = log.findLast((item) => item.type === "inbox.enqueued")! as StoredEvent<"inbox.enqueued">
    const delivered = log.find((item) => item.type === "inbox.delivered" && item.data.messageId === second.data.messageId)!
    // The parent answered the message: nothing of the parent is lost by forking.
    expect(parent.projection().messages.some((message) => message.id === second.data.messageId)).toBe(true)
    const window = log.filter((item) => item.seq >= second.seq && item.seq < delivered.seq)
    expect(window.length).toBeGreaterThan(1)

    for (const point of window) {
      const fork = await engine.forkSession(parent.id, { throughSeq: point.seq })
      const projection = fork.projection()
      expect(projection.inbox).toEqual([])
      expect(projection.session.execution).toBeNull()
      expect(projection.messages.some((message) => message.id === second.data.messageId)).toBe(false)
      // The engine's title is the parent's own as of the point: nobody named it.
      expect(projection.session.title).toBeNull()
      // The inherited log does hold the enqueue: that is what a title derived from the log without the delivery finds.
      expect(texts(fork.readEvents())).toContain("Second question.")
      fork.send("Go on.")
      await fork.settled()
      expect(fork.readEvents().at(-1)?.type).toBe("execution.succeeded")
      await fork.close()
    }
  }, 60_000)

  test("before the very first delivery: the fork has no messages at all", async () => {
    const { data, workspace } = place("wl-fork-window-")
    const { harness } = start(data, [say("One."), say("In the fork.")])
    const engine = harness.engine
    const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS })
    parent.send("First question.")
    await parent.settled()
    const enqueued = parent.readEvents().find((item) => item.type === "inbox.enqueued")!
    const fork = await engine.forkSession(parent.id, { throughSeq: enqueued.seq })
    expect(fork.projection().messages).toEqual([])
    expect(fork.projection().inbox).toEqual([])
    // What a client names it by is what it has: nothing yet, while its parent is named by the prompt.
    expect(engine.getSession(fork.id)?.firstPrompt).toBeNull()
    expect(engine.getSession(parent.id)?.firstPrompt).toBe("First question.")
  }, 60_000)
})
