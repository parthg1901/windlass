/**
 * The history tools through the loop: the model calls `history_search` and
 * `history_read`, the real tools run against the session's own store, and
 * the results are what a model can work with after a compaction.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { OUTPUT_LIMITS } from "../../src/tool/cap.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { SUMMARY, measured } from "../scenarios/script.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const settledOf = (h: Harness) => h.log().filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled")
const lastResult = (h: Harness) => settledOf(h).at(-1)!.data

/** A log of 300 lines (about 3,600 tokens) with one line that matters two thirds down. */
const LOG = [
  ...Array.from({ length: 200 }, (_, index) => `[info] request ${index} served in ${(index * 7) % 90} ms`),
  "[fatal] worker 17 exited: SIGSEGV in libledger.so at offset 0x7f3a (build 4411)",
  ...Array.from({ length: 100 }, (_, index) => `[info] request ${200 + index} served in ${(index * 3) % 90} ms`),
].join("\n")

describe("the history tools", () => {
  test("are in every session's tool list from its first request, as read tools, and stay there across a compaction", async () => {
    const h = new Harness({ contextWindow: 10_000 })
    try {
      h.tools.on("read", "export const a = 1")
      h.provider.enqueue([call("read", { path: "a.ts" }), script.usage(measured(6000))], [script.text(SUMMARY)], [call("history_search", { query: "a.ts" }), U], [script.text("Done."), U])
      h.create().send("Read a.ts.")
      await h.settled()
      const names = h.provider.requests.map((request) => request.tools.map((tool) => tool.name))
      expect(names[0]).toEqual(["history_read", "history_search", "read", "shell", "write"])
      // The same list before the compaction, in its summary request and after it: the tools were never added or dropped.
      for (const list of names) expect(list).toEqual(names[0]!)
      expect(h.log().filter((item) => item.type === "tool.started").map((item) => item.data.effect)).toEqual(["read", "read"])
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("after a compaction the model finds an exact detail in a message that is out of its view, and reads around it", async () => {
    const h = new Harness({ contextWindow: 10_000 })
    try {
      h.tools.on("shell", LOG).on("read", "export const a = 1")
      h.provider.enqueue(
        [call("shell", { command: "cat server.log" }), script.usage(measured(1000))],
        [call("read", { path: "a.ts" }), script.usage(measured(6000))],
        [script.text(SUMMARY)],
        [call("history_search", { query: "worker exited SIGSEGV" }), U],
        (request) => {
          // The hit names the message and where in it the match is; the model reads from there.
          const output = request.input.at(-1)
          const found = /\[seq (\d+), offset (\d+)\]/.exec(output?.type === "tool_result" ? output.output : "")!
          return [call("history_read", { seq: Number(found[1]), offset: Number(found[2]) - 60, limit: 200 }), U]
        },
        [script.text("Worker 17 crashed in libledger.so (build 4411)."), U],
      )
      h.create().send("Why did the server stop?")
      await h.settled()
      expect(h.diagnostics).toEqual([])
      const [, , search, read] = settledOf(h).map((item) => item.data)
      // The shell step is behind the checkpoint: the request that searched did not hold its output.
      const searching = h.provider.requests[3]!
      expect(JSON.stringify(searching.input)).not.toContain("SIGSEGV")
      expect(search!.outcome).toBe("success")
      expect(search!.output).toContain("tool (shell): ")
      expect(search!.output).toContain("[fatal] worker 17 exited: SIGSEGV in libledger.so at offset 0x7f3a (build 4411)")
      expect(search!.display).toMatchObject({ query: "worker exited SIGSEGV" })
      // The read starts a little before the match and returns the stored text around it.
      expect(read!.outcome).toBe("success")
      expect(read!.output).toContain("characters ")
      expect(read!.output).toContain("SIGSEGV in libledger.so at offset 0x7f3a (build 4411)")
      expect(read!.output).toContain("[More: call history_read with offset ")
      expect(read!.output).toMatch(/\[the message before it is seq \d+; the one after it is seq \d+\.\]/)
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("their output goes through the same cap as every tool's, and what they are not given is said plainly", async () => {
    const h = new Harness()
    try {
      const lines = Array.from({ length: 5_000 }, (_, index) => `l${index}`).join("\n")
      h.provider.enqueue(
        [script.text(lines), U],
        // 20,000 characters of very short lines: more lines than a tool result may have.
        [call("history_read", { seq: 6, limit: 20_000 }), U],
        [call("history_read", { seq: 7 }), U],
        [call("history_search", { query: "   " }), U],
        [call("history_read", { seq: 6, offset: -1 }), U],
        [call("history_search", { query: "l4999", limit: 1 }), U],
        [script.text("Done."), U],
      )
      h.create().send("Count to five thousand.")
      await h.settled()
      h.session.send("Now read that again.")
      await h.settled()
      const [capped, missing, blank, negative, found] = settledOf(h).map((item) => item.data)
      expect(capped!.outcome).toBe("success")
      expect(capped!.truncation?.originalLines ?? 0).toBeGreaterThan(OUTPUT_LIMITS.maxLines)
      expect(capped!.truncation?.spillPath).toContain("spill")
      expect(capped!.output.split("\n").length).toBeLessThanOrEqual(OUTPUT_LIMITS.maxLines)
      // Seq 7 is an event, not a message: the tool says so and names the nearest ones.
      expect(missing).toMatchObject({ outcome: "error", output: "No message can be read at seq 7. The nearest messages are seq 6 and seq 12. Use history_search to find a message." })
      // The runtime's schema check refuses what the schema rules out, before the tool runs.
      expect(blank!.outcome).toBe("error")
      expect(negative!.outcome).toBe("error")
      expect(found!.output.split("\n")[0]).toBe('1 message matches "l4999"; showing 1, best first.')
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a reverted turn cannot be read or found through them", async () => {
    const h = new Harness()
    try {
      h.provider.enqueue([script.text("The passphrase is plum-orchard-91."), U], [script.text("Yes."), U], [call("history_search", { query: "plum-orchard-91" }), call("history_read", { seq: 5 }, "call_2"), U], [script.text("Nothing."), U])
      h.create().send("Remember the passphrase plum-orchard-91.")
      await h.settled()
      h.session.send("Still there?")
      await h.settled()
      // Both turns are rewound; the next one asks for what they said.
      const first = h.session.projection().messages[0]!
      expect(await h.session.revert({ messageId: first.id })).toMatchObject({ kind: "reverted" })
      h.session.send("What was the passphrase?")
      await h.settled()
      const [search, read] = settledOf(h).map((item) => item.data)
      expect(search!.output).toBe('No earlier message matches "plum-orchard-91".')
      expect(read).toMatchObject({ outcome: "error" })
      expect(read!.output).toContain("No message can be read at seq 5.")
      expect(JSON.stringify(h.provider.requests.at(-1)!.input)).not.toContain("plum-orchard-91\"")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a call's own step is not history yet, and a build that brings a tool of the same name keeps its own", async () => {
    const h = new Harness()
    try {
      h.provider.enqueue([call("history_search", { query: "needle-in-this-call" }), U], [script.text("Nothing."), U])
      h.create().send("Search for it.")
      await h.settled()
      expect(lastResult(h).output).toBe('No earlier message matches "needle-in-this-call".')
    } finally {
      await h.dispose()
    }
    const own = new Harness({ tools: new (await import("./harness.ts")).ScriptedTools({ read: "read", history_search: "read" }) })
    try {
      own.tools.on("history_search", "the build's own search")
      own.provider.enqueue([call("history_search", { query: "x" }), U], [script.text("Done."), U])
      own.create().send("Search.")
      await own.settled()
      expect(lastResult(own).output).toBe("the build's own search")
      expect(own.provider.requests[0]!.tools.map((tool) => tool.name)).toEqual(["history_read", "history_search", "read"])
    } finally {
      await own.dispose()
    }
  })
})
