/**
 * A response that says something after a tool call.
 *
 * The request builder replays a response's output in the order the model
 * produced it, then the results of its calls (`renderAssistant` in
 * `request/build.ts`). So a response of a call and then text is sent back as
 * call, text, result. The provider accepts that order and answers from the
 * result (docs/reference/responses-api.md, section 3.1, [live] 2026-11-13),
 * so the request check every engine test runs (`danglingCalls`) accepts it too.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { script } from "../../src/testing/fake-provider.ts"
import { measured } from "../scenarios/script.ts"
import { Harness, danglingCalls, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const item = (type: string, callId?: string) => (callId === undefined ? { type } : { type, callId })

describe("text after a tool call", () => {
  test("the engine sends the call, the text, then the result, and the request passes the check", async () => {
    const h = new Harness()
    try {
      h.tools.on("read", "const a = 1")
      h.provider.enqueue([script.toolCall("call_1", "read", { path: "a.ts" }), script.text("Reading a.ts."), U], [script.text("Done."), U])
      h.create().send("Read a.ts.")
      await h.settled()
      const second = h.provider.calls[1]!.request.input
      expect(second.slice(-3).map((entry) => entry.type)).toEqual(["tool_call", "assistant_text", "tool_result"])
      expect(danglingCalls(second)).toEqual([])
      expect(h.log().at(-1)?.type).toBe("execution.succeeded")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("the check still finds a call with no result before the next message or the next response", () => {
    expect(danglingCalls([item("tool_call", "c1"), item("assistant_text"), item("tool_call", "c2"), item("tool_result", "c1"), item("tool_result", "c2")])).toEqual([])
    expect(danglingCalls([item("tool_call", "c1"), item("assistant_text"), item("message")])).toEqual(["item 2: call c1 has no result before the next message"])
    expect(
      danglingCalls([item("tool_call", "c1"), item("tool_call", "c2"), item("tool_result", "c1"), item("assistant_text"), item("tool_result", "c2")]),
    ).toEqual(["item 3: call c2 has no result before the next response", "item 4: result c2 has no call before it"])
    expect(danglingCalls([item("tool_call", "c1"), item("assistant_text")])).toEqual(["call c1 has no result"])
  })
})
