/**
 * Known defect 5: `forkSession` with `throughSeq` between a message's
 * `inbox.enqueued` and its `inbox.delivered` makes a fork without that
 * message (it keeps the title that message gave the session, and the client
 * says "with the conversation so far").
 *
 * What the rules say. `forkSession` (`engine.ts`) folds the parent's log to
 * `throughSeq` and accepts the point when `state.session.open === null`; the
 * reducer's `create` (`message/reducer.ts`) checks the same thing ("a fork
 * point must be a step boundary") and gives the fork `inbox: []`. Between an
 * `inbox.enqueued` and its `inbox.delivered` only the claim, the baseline, a
 * delivery snapshot and appended instructions are written; no step or
 * compaction is open. So every point in that window is a legal boundary, and
 * the contract's "what it does not inherit: the inbox, the claim" applies:
 * the message is not lost (it stays in the parent's inbox and the parent
 * delivers it), it was never the fork's.
 *
 * The title is not the engine's: the engine gives the fork the parent's
 * `session.title` as of the fork point (`null` when nobody named it). The ACP
 * server's fork handler (`packages/acp/src/server.ts`, the `forkSession` call
 * with `forkTitle(this.titleOf(...))`) derives the parent's title with
 * `titleOf`, which reads the parent's log from its start
 * (`readEvents(sessionId, { limit: TITLE_SCAN_EVENTS })`, not bounded by
 * `throughSeq`) and takes the first user `inbox.enqueued`
 * (`titleFromEvents`, `packages/acp/src/extensions.ts`), delivered or not. A
 * fork made before the first prompt was delivered is therefore named after
 * a prompt it does not have.
 *
 * RECOMMENDED (what these tests assert; they hold today, so they are plain
 * tests, not `test.failing`): the point stays legal and the inbox stays the
 * parent's; the fixes are outside the engine: the ACP server derives the
 * fork's title from events through `throughSeq` that were delivered
 * (`inbox.delivered`), and a client that forks at a point where input waits
 * says that the waiting message is not in the fork.
 * ALTERNATIVES for the owner: refuse a point where the parent's inbox holds
 * an item the running claim is about to hand over (from its `execution.started`
 * to the `inbox.delivered`), naming the boundaries on either side, as "inside
 * a step" is refused; or let the fork inherit the waiting items as its inbox
 * (a change of the contract, and of `create`).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import type { StoredEvent } from "../../src/event/durable.ts"
import { SETTINGS, closeHarnesses, place, removePlaces, say, start } from "../engine/assembly-helpers.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

const texts = (events: readonly StoredEvent[]) => events.flatMap((item) => (item.type === "inbox.enqueued" ? item.data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : []))

describe("known defect 5: a fork between a message's enqueue and its delivery", () => {
  test("every point in that window is a boundary; the fork has neither the message nor an inbox, and the parent still delivers it", async () => {
    const { data, workspace } = place("lh-defect-5-")
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
    console.log(`defect 5: the window is ${window.map((item) => `${item.seq} ${item.type}`).join(", ")}`)
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
    const { data, workspace } = place("lh-defect-5-")
    const { harness } = start(data, [say("One."), say("In the fork.")])
    const engine = harness.engine
    const parent = engine.createSession({ cwd: workspace("w"), settings: SETTINGS })
    parent.send("First question.")
    await parent.settled()
    const enqueued = parent.readEvents().find((item) => item.type === "inbox.enqueued")!
    const fork = await engine.forkSession(parent.id, { throughSeq: enqueued.seq })
    expect(fork.projection().messages).toEqual([])
    expect(fork.projection().inbox).toEqual([])
  }, 60_000)
})
