/**
 * Forking a fork at a point of the history it inherited.
 *
 * A fork's log begins with its parent's events through its fork point, under
 * the same numbers, so a point there is a point of the parent's log: forking
 * the fork at it forks the session that history came from, and the new
 * fork's lineage names that session (`forkPointOwner` in `engine.ts`). A
 * point of the fork's own part, and the default (its latest boundary), stay
 * the fork's. When the file that holds the point is gone, the refusal is a
 * sentence that names it.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { basename, join } from "node:path"
import { EngineError } from "../../src/engine/engine.ts"
import type { SessionId } from "../../src/id.ts"
import { selectModelHistory } from "../../src/message/history.ts"
import { comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import { SETTINGS, call, closeHarnesses, place, removePlaces, say, start } from "./assembly-helpers.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

/** A session with two turns, and a fork of it at its end that has one more turn of its own. */
async function forked() {
  const { data, workspace, root } = place()
  const { harness, provider } = start(data, [[call("read", { path: "notes.md" })], say("It is a notes file."), say("Again: a notes file."), say("In the fork."), say("In the fork of the fork.")])
  const engine = harness.engine
  const original = engine.createSession({ cwd: workspace("w"), settings: SETTINGS, title: "Notes" })
  original.send("What is notes.md?")
  await original.settled()
  const first = original.projection()
  original.send("Again?")
  await original.settled()
  const fork = await engine.forkSession(original.id)
  fork.send("And in the fork?")
  await fork.settled()
  return { engine, harness, provider, original, fork, first, root }
}

describe("forking a fork at a point it inherited", () => {
  test("the new fork is a fork of the session that point belongs to, with that session's history up to it, and it runs", async () => {
    const { engine, provider, original, fork, first } = await forked()
    const again = await engine.forkSession(fork.id, { throughSeq: first.lastSeq })
    const state = again.projection()
    expect(state.session.lineage).toEqual({ kind: "fork", parentSessionId: original.id, throughSeq: first.lastSeq })
    expect(state.session.rootId).toBe(original.id)
    expect(state.messages).toEqual(first.messages)
    expect(state.baseline).toEqual(first.baseline)
    expect(selectModelHistory(state).messages.map((message) => message.id)).toEqual(selectModelHistory(first).messages.map((message) => message.id))
    expect(again.readEvents().slice(0, first.lastSeq)).toEqual([...original.readEvents({ limit: first.lastSeq })])
    again.send("And here?")
    await again.settled()
    expect(again.readEvents().at(-1)?.type).toBe("execution.succeeded")
    // Its first request extends the request that ended the turn it was forked after.
    expect(comparePrefix(hashRequest(provider.requests[1]!), hashRequest(provider.requests.at(-1)!))).toMatchObject({ extension: true })
  }, 60_000)

  test("the fork's own fork point is the parent's point too; a point of its own part, and no point, stay the fork's", async () => {
    const { engine, original, fork } = await forked()
    const at = (fork.projection().session.lineage as { throughSeq: number }).throughSeq
    expect((await engine.forkSession(fork.id, { throughSeq: at })).projection().session.lineage).toEqual({ kind: "fork", parentSessionId: original.id, throughSeq: at })
    const latest = fork.projection().lastSeq
    expect((await engine.forkSession(fork.id)).projection().session.lineage).toEqual({ kind: "fork", parentSessionId: fork.id, throughSeq: latest })
    expect((await engine.forkSession(fork.id, { throughSeq: latest })).projection().session.lineage).toEqual({ kind: "fork", parentSessionId: fork.id, throughSeq: latest })
  }, 60_000)

  test("through two forks: a point of the first session is found from a fork of its fork", async () => {
    const { engine, original, fork, first } = await forked()
    const second = await engine.forkSession(fork.id)
    second.send("And one more?")
    await second.settled()
    const third = await engine.forkSession(second.id, { throughSeq: first.lastSeq })
    expect(third.projection().session.lineage).toEqual({ kind: "fork", parentSessionId: original.id, throughSeq: first.lastSeq })
    // A point of the middle fork's own part belongs to the middle fork.
    const middle = fork.projection().lastSeq
    expect((await engine.forkSession(second.id, { throughSeq: middle })).projection().session.lineage).toEqual({ kind: "fork", parentSessionId: fork.id, throughSeq: middle })
  }, 60_000)

  test("an inherited point inside a step is refused as any such point is, with the nearest boundary named", async () => {
    const { engine, original, fork } = await forked()
    const inside = original.readEvents().find((item) => item.type === "tool.started")!.seq
    const refused = (await engine.forkSession(fork.id, { throughSeq: inside }).catch((error: unknown) => error)) as EngineError
    expect(refused).toBeInstanceOf(EngineError)
    expect(refused.code).toBe("invalid_request")
    expect(refused.message).toContain("is inside a step: a session is forked at a step boundary")
  }, 60_000)

  test("when the file that holds the point is gone, the refusal says which session's history is missing and names the file", async () => {
    const { engine, harness, original, fork, first, root } = await forked()
    const path = harness.sessions.pathOf(original.id as SessionId)
    await original.close()
    mkdirSync(join(root, "moved"), { recursive: true })
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, join(root, "moved", `${basename(path)}${suffix}`))
    for (const options of [{ throughSeq: first.lastSeq }, {}]) {
      const refused = (await engine.forkSession(fork.id, options).catch((error: unknown) => error)) as EngineError
      expect(refused).toBeInstanceOf(EngineError)
      expect(refused.code).toBe("invalid_request")
      expect(refused.message).toBe(`session ${fork.id} cannot be forked: the history inherited from session ${original.id} cannot be read: ${path} is missing`)
    }
  }, 60_000)
})
