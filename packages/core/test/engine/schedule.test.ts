/**
 * How the calls of one response are scheduled (`beginTools`, `schedule/`):
 * by what they touch, and as soon as their arguments finish streaming. The
 * tools here take real time, so that "at the same time" and "one after the
 * other" are measured, not assumed.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import { TOOL_TEXT } from "../../src/engine/constants.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, type HarnessOptions, removeHarnessDirectories } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

/** A sandbox that plans nothing: the scripted tools spawn no process. */
const sandbox: CommandSandbox = {
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
}
const APPROVAL: ApprovalSetup = { sandbox, secrets: [], home: "/home/user" }

async function withHarness(run: (h: Harness) => Promise<void>, options: HarnessOptions = {}) {
  const h = new Harness(options)
  try {
    await run(h)
    h.verify()
  } finally {
    await h.dispose()
  }
}

const write = (callId: string, path: string) => script.toolCall(callId, "write", { path, content: "x" })
const shell = (callId: string, command: string) => script.toolCall(callId, "shell", { command })
const read = (callId: string, path: string) => script.toolCall(callId, "read", { path })
const U = script.usage({ inputTokens: 100, outputTokens: 10 })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** When each call's tool ran, by call input: a behaviour that takes `ms` and records its interval. */
function timed(spans: Map<string, { start: number; end: number }>, label: (input: Record<string, unknown>) => string, ms: number) {
  return async (input: Record<string, unknown>) => {
    const span = { start: performance.now(), end: Number.NaN }
    spans.set(label(input), span)
    await sleep(ms)
    span.end = performance.now()
    return `done ${label(input)}`
  }
}
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end
const byPath = (input: Record<string, unknown>) => String(input.path ?? input.command)
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const settled = (h: Harness) => of(h, "tool.settled").map((item) => [String(item.data.callId), item.data.outcome])

for (const layer of ["off", "on"] as const) {
  const options: HarnessOptions = layer === "on" ? { approval: APPROVAL } : {}

  describe(`with the approval layer ${layer}`, () => {
    test("two edits of different files run at the same time", () =>
      withHarness(async (h) => {
        const spans = new Map<string, { start: number; end: number }>()
        h.provider.enqueue([write("call_1", "a.ts"), write("call_2", "b.ts"), U], [script.text("Done.")])
        h.tools.on("write", timed(spans, byPath, 60), timed(spans, byPath, 60))
        h.create().send("Edit both.")
        await h.settled()
        expect(overlap(spans.get("a.ts")!, spans.get("b.ts")!)).toBe(true)
      }, options))

    test("two edits of one file run one after the other, in the order written", () =>
      withHarness(async (h) => {
        const spans = new Map<string, { start: number; end: number }>()
        h.provider.enqueue([write("call_1", "a.ts"), write("call_2", "./a.ts"), U], [script.text("Done.")])
        h.tools.on("write", timed(spans, byPath, 40), timed(spans, byPath, 40))
        h.create().send("Edit it twice.")
        await h.settled()
        expect(spans.get("./a.ts")!.start).toBeGreaterThanOrEqual(spans.get("a.ts")!.end)
        expect(h.tools.ran.map((call) => call.input.path)).toEqual(["a.ts", "./a.ts"])
      }, options))

    test("a command waits for the edit written before it, an edit written after it waits for the command, and commands run together", () =>
      withHarness(async (h) => {
        const spans = new Map<string, { start: number; end: number }>()
        h.provider.enqueue([write("call_1", "a.ts"), shell("call_2", "bun test"), shell("call_3", "bun run lint"), write("call_4", "b.ts"), U], [script.text("Done.")])
        h.tools.on("write", timed(spans, byPath, 40), timed(spans, byPath, 40)).on("shell", timed(spans, byPath, 60), timed(spans, byPath, 60))
        h.create().send("Edit, test, lint, edit.")
        await h.settled()
        const [a, test$, lint, b] = ["a.ts", "bun test", "bun run lint", "b.ts"].map((name) => spans.get(name)!)
        expect(test$!.start).toBeGreaterThanOrEqual(a!.end)
        expect(lint!.start).toBeGreaterThanOrEqual(a!.end)
        expect(overlap(test$!, lint!)).toBe(true)
        expect(b!.start).toBeGreaterThanOrEqual(Math.max(test$!.end, lint!.end))
      }, options))
  })
}

test("two names of one file through a link are one file: the edits run one after the other", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-schedule-")))
  made.push(root)
  mkdirSync(join(root, "real"))
  symlinkSync(join(root, "real"), join(root, "link"))
  return withHarness(async (h) => {
    const spans = new Map<string, { start: number; end: number }>()
    h.provider.enqueue([write("call_1", join(root, "real", "a.ts")), write("call_2", join(root, "link", "a.ts")), U], [script.text("Done.")])
    h.tools.on("write", timed(spans, byPath, 40), timed(spans, byPath, 40))
    h.create().send("Edit it twice.")
    await h.settled()
    expect(spans.get(join(root, "link", "a.ts"))!.start).toBeGreaterThanOrEqual(spans.get(join(root, "real", "a.ts"))!.end)
  })
})

test("results reach the log in the order they finish, and the request in the order they were called", () =>
  withHarness(async (h) => {
    h.provider.enqueue([read("call_1", "slow.ts"), read("call_2", "fast.ts"), U], [script.text("Done.")])
    h.tools.on(
      "read",
      async () => {
        await sleep(40)
        return "slow"
      },
      "fast",
    )
    h.create().send("Read both.")
    await h.settled()
    expect(settled(h)).toEqual([
      ["call_2", "success"],
      ["call_1", "success"],
    ])
    const results = h.provider.requests[1]!.input.flatMap((item) => (item.type === "tool_result" ? [item.callId] : []))
    expect(results).toEqual(["call_1", "call_2"])
  }))

describe("a call starts as soon as its arguments finish streaming", () => {
  test("before the response ends", () =>
    withHarness(async (h) => {
      let responseOver = null as boolean | null
      h.provider.enqueue([shell("call_1", "bun test"), script.delay(30), shell("call_2", "bun run lint"), U], [script.text("Done.")])
      h.tools.on(
        "shell",
        () => {
          responseOver = h.provider.calls[0]!.events.some((item) => item.type === "finish") as boolean | null
          return "ok"
        },
        "ok",
      )
      h.create().send("Test and lint.")
      await h.settled()
      expect(responseOver).toBe(false)
      const types = h.log().map((item) => `${item.type}${"callId" in item.data ? ` ${String(item.data.callId)}` : ""}`)
      expect(types.indexOf("tool.started call_1")).toBeLessThan(types.indexOf("tool.called call_2"))
    }, { approval: APPROVAL }))

  test("a call that must ask waits for the response to end before the question is asked", () =>
    withHarness(async (h) => {
      const order: string[] = []
      h.at("model.finished", 1, () => order.push("response over"))
      h.at("approval.requested", 1, () => order.push("asked"))
      h.provider.enqueue([write("call_1", "/etc/motd"), script.delay(30), read("call_2", "a.ts"), U], [script.text("Done.")])
      h.tools.on("read", () => (order.push("read ran"), "a")).on("write", "written")
      const session = h.create()
      session.send("Go.")
      const question = await h.seen((item) => item.type === "approval.requested")
      expect(session.answer({ messageId: (question as StoredEvent<"approval.requested">).data.messageId, callId: (question as StoredEvent<"approval.requested">).data.callId }, { choice: "once" })).toBe(true)
      await h.settled()
      // The read, which needs no answer, did not wait behind the question.
      expect(order).toEqual(["read ran", "response over", "asked"])
      expect(settled(h)).toEqual([
        ["call_2", "success"],
        ["call_1", "success"],
      ])
    }, { approval: APPROVAL, attended: true }))

  test("a stream that fails after a call started: the call finishes, the call waiting behind it never starts, and the step fails and is continued", () =>
    withHarness(async (h) => {
      h.provider.enqueue(
        [shell("call_1", "bun run migrate"), write("call_2", "CHANGELOG.md"), script.fail("transport", { message: "connection reset" })],
        [script.text("The migration ran; the changelog is not written yet.")],
      )
      h.tools.on("shell", async () => {
        await h.responded(0)
        return "migrated"
      })
      h.create().send("Migrate and note it.")
      await h.settled()
      expect(h.tools.ran.map((call) => call.name)).toEqual(["shell"])
      expect(of(h, "tool.settled").map((item) => [String(item.data.callId), item.data.outcome, item.data.output])).toEqual([
        ["call_1", "success", "migrated"],
        ["call_2", "not_started", TOOL_TEXT.notStarted],
      ])
      const types = h.log().map((item) => item.type)
      const failedAt = types.indexOf("step.failed")
      expect(types.slice(failedAt, failedAt + 3)).toEqual(["step.failed", "retry.scheduled", "synthetic.appended"])
      // The model is shown what ran: the call and its result, in the request after the failure.
      expect(JSON.stringify(h.provider.requests[1]!.input)).toContain("migrated")
    }, { approval: APPROVAL }))
})

test("three one-second commands in one response, streamed over 0.6 s, take 0.6 s + 1 s, not 0.6 s + 3 s", () =>
  withHarness(async (h) => {
    h.provider.enqueue(
      [shell("call_1", "sleep 1 # a"), script.delay(300), shell("call_2", "sleep 1 # b"), script.delay(300), shell("call_3", "sleep 1 # c"), U],
      [script.text("Done.")],
    )
    const second = async () => {
      await sleep(1000)
      return "slept"
    }
    h.tools.on("shell", second, second, second)
    const began = performance.now()
    h.create().send("Sleep three times.")
    await h.settled()
    const took = performance.now() - began
    // One after the other, after the whole response: 0.6 s + 3 s. Together, each as it arrives: 0.6 s + 1 s at most.
    expect(took).toBeLessThan(2000)
    console.log(`three 1 s commands, response streamed over 0.6 s: ${Math.round(took)} ms`)
  }, { approval: APPROVAL }), 10_000)

test("a one-second command followed by a second more of the response takes one second, not two", () =>
  withHarness(async (h) => {
    h.provider.enqueue([shell("call_1", "sleep 1"), script.delay(1000), read("call_2", "a.ts"), U], [script.text("Done.")])
    h.tools
      .on("shell", async () => {
        await sleep(1000)
        return "slept"
      })
      .on("read", "a")
    const began = performance.now()
    h.create().send("Test.")
    await h.settled()
    expect(performance.now() - began).toBeLessThan(1600)
  }, { approval: APPROVAL }), 10_000)
