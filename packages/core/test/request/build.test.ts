/** One direct test per rendering rule of the request builder. */
import { describe, expect, test } from "bun:test"
import { type Content, text } from "../../src/content.ts"
import { event } from "../../src/event/durable.ts"
import type { MessageId, SessionId } from "../../src/id.ts"
import type { AssistantMessage, Projection } from "../../src/message/message.ts"
import { reduce } from "../../src/message/reducer.ts"
import {
  RequestBuildError,
  buildCompactionRequest,
  buildRequest,
  buildRequestFromHistory,
  renderMessage,
} from "../../src/request/build.ts"
import { canonicalJson } from "../../src/request/canonical.ts"
import { comparePrefix, hashRequest } from "../../src/request/prefix.ts"
import { requestBlocks } from "../../src/request/request.ts"
import { sortTools } from "../../src/tool/tool.ts"
import {
  BASELINE,
  ENCRYPTED,
  MODEL,
  OPTIONS,
  PARAMS,
  READ,
  SHELL,
  Script,
  called,
  developer,
  harness,
  providerProblems,
  result,
  said,
  thought,
  user,
} from "./session.ts"

const IMAGE = { hash: "ab".repeat(32), mediaType: "image/png" }

/** A session with one delivered prompt and a running execution. */
function prompted(value = "fix the bug") {
  const s = new Script().open()
  s.user(value)
  return s
}

describe("baseline", () => {
  test("instructions and tools are copied from the baseline as stored", () => {
    const request = prompted().request()
    expect(request.instructions).toBe(BASELINE.instructions)
    expect(request.tools).toEqual(BASELINE.tools)
    expect(request.toolChoice).toBe("auto")
  })

  test("tool order is the frozen order, even when that order is not sorted", () => {
    const frozen = [SHELL, READ]
    const s = new Script().open({ instructions: "x", tools: frozen })
    expect(s.request().tools.map((tool) => tool.name)).toEqual(["shell", "read"])
    expect(sortTools(frozen).map((tool) => tool.name)).toEqual(["read", "shell"])
  })

  test("a request cannot be built before the first baseline", () => {
    const s = new Script()
    s.apply(event("session.created", { cwd: "/repo", title: null, lineage: null }))
    expect(() => s.request()).toThrow(RequestBuildError)
    expect(() => s.request()).toThrow("no baseline.set")
  })

  test("params carry exactly the five cache-relevant fields", () => {
    const loose = { ...PARAMS, temperature: 0.2 }
    const request = prompted().request({ params: loose, toolChoice: "none" })
    expect(request.params).toEqual(PARAMS)
    expect(request.toolChoice).toBe("none")
  })

  test("toolChoice is not part of the prefix", () => {
    const s = prompted()
    const comparison = comparePrefix(s.hashes(), s.hashes({ params: PARAMS, toolChoice: "none" }))
    expect(comparison).toEqual({ extension: true, appended: 0 })
  })
})

describe("what a change is reported as", () => {
  const before = () => prompted().hashes()
  const changed = (baseline: typeof BASELINE) => {
    const s = new Script().open(baseline)
    s.user("fix the bug")
    return comparePrefix(before(), s.hashes())
  }

  test("a changed tool description is a tool change at that tool's block", () => {
    const comparison = changed({ ...BASELINE, tools: [READ, { ...SHELL, description: "Run a shell command" }] })
    expect(comparison).toMatchObject({ extension: false, kind: "tool", index: 2, change: "changed" })
  })

  test("a changed tool order is a tool change at the first tool", () => {
    expect(changed({ ...BASELINE, tools: [SHELL, READ] })).toMatchObject({ extension: false, kind: "tool", index: 1 })
  })

  test("an added tool is a tool change", () => {
    const extra = { name: "write", description: "Write a file", inputSchema: { type: "object" } }
    expect(changed({ ...BASELINE, tools: [READ, SHELL, extra] })).toMatchObject({ extension: false, kind: "tool", index: 3 })
  })

  test("changed baseline text is an instructions change", () => {
    const comparison = changed({ ...BASELINE, instructions: "You are a careful coding agent." })
    expect(comparison).toMatchObject({ extension: false, kind: "instructions", index: 3 })
  })

  test("a changed model is a params change", () => {
    const s = prompted()
    const other = s.hashes({ params: { ...PARAMS, model: "gpt-other" }, toolChoice: "auto" })
    expect(comparePrefix(s.hashes(), other)).toMatchObject({ extension: false, kind: "params", index: 0 })
  })

  test("a rewritten tool output would be an input change", () => {
    const build = (output: string) => {
      const s = prompted()
      s.step({ parts: [{ call: "call_1", output }] })
      return s.hashes()
    }
    expect(comparePrefix(build("const a = 1"), build("const a = 2"))).toMatchObject({ extension: false, kind: "input", index: 6 })
  })
})

describe("user and harness messages", () => {
  test("a user message is a user message with its content as stored", () => {
    const s = new Script().open()
    const content: Content = [{ type: "text", text: "look at this" }, { type: "media", blob: IMAGE }]
    const messageId = "usr_x" as MessageId
    s.apply(event("inbox.enqueued", { messageId, origin: null, delivery: "queue", content }))
    s.deliver(messageId)
    expect(s.input()).toEqual([{ type: "message", role: "user", content }])
  })

  test("steer and queue delivery render the same", () => {
    const steer = new Script().open()
    steer.user("hello", "steer")
    const queue = new Script().open()
    queue.user("hello", "queue")
    expect(canonicalJson(steer.request())).toBe(canonicalJson(queue.request()))
  })

  test("blank text parts are not sent, and a message with nothing left is skipped", () => {
    const s = new Script().open()
    const blank = "usr_blank" as MessageId
    const mixed = "usr_mixed" as MessageId
    s.apply(
      event("inbox.enqueued", { messageId: blank, origin: null, delivery: "steer", content: [{ type: "text", text: " \n" }] }),
      event("inbox.enqueued", {
        messageId: mixed,
        origin: null,
        delivery: "steer",
        content: [{ type: "text", text: "" }, { type: "media", blob: IMAGE }],
      }),
    )
    s.deliver(blank)
    s.deliver(mixed)
    expect(s.input()).toEqual([{ type: "message", role: "user", content: [{ type: "media", blob: IMAGE }] }])
  })

  test("a synthetic message is a user message inside the harness envelope, whichever way it arrived", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", name: "shell" }] })
    s.background("background-command", "Command 1 finished with exit code 0.")
    s.harness("check", "The type check failed.")
    expect(s.input().slice(-2)).toEqual([
      user('<harness origin="background-command">\nCommand 1 finished with exit code 0.\n</harness>'),
      user('<harness origin="check">\nThe type check failed.\n</harness>'),
    ])
  })

  test("the interrupt marker is a harness message that follows the interrupted output", () => {
    const s = prompted()
    s.step({ parts: [{ text: "I will start with" }], end: "interrupted" })
    s.interruptExecution()
    s.harness("interrupt", "Your previous response was interrupted by the user.")
    s.user("do something else")
    expect(s.input()).toEqual([
      user("fix the bug"),
      said("I will start with"),
      harness("interrupt", "Your previous response was interrupted by the user."),
      user("do something else"),
    ])
  })

  test("the envelope stands next to media instead of being joined to it", () => {
    const s = prompted()
    s.apply(
      event("synthetic.appended", {
        messageId: "syn_x" as MessageId,
        origin: "screenshot",
        content: [{ type: "media", blob: IMAGE }, { type: "text", text: "after the click" }, { type: "media", blob: IMAGE }],
      }),
    )
    expect(s.input().at(-1)).toEqual({
      type: "message",
      role: "user",
      content: [
        { type: "text", text: '<harness origin="screenshot">\n' },
        { type: "media", blob: IMAGE },
        { type: "text", text: "after the click" },
        { type: "media", blob: IMAGE },
        { type: "text", text: "\n</harness>" },
      ],
    })
  })

  test("a harness message with nothing to say is skipped", () => {
    const s = prompted()
    s.harness("check", "   ")
    expect(s.input()).toEqual([user("fix the bug")])
  })
})

describe("instruction messages", () => {
  test("an instruction message is a developer message with its text as stored", () => {
    const s = prompted()
    s.instruction("date", "The date has changed.\n<date lines=\"1\">\nThursday, 2026-11-12\n</date>")
    expect(s.input().at(-1)).toEqual(developer("The date has changed.\n<date lines=\"1\">\nThursday, 2026-11-12\n</date>"))
  })

  test("a blank instruction message is skipped", () => {
    const s = prompted()
    s.instruction("date", "")
    expect(s.input()).toEqual([user("fix the bug")])
  })

  test("an instruction message older than the baseline in force is dropped, a newer one is kept", () => {
    const s = prompted()
    s.step({ parts: [{ text: "One." }] })
    const kept = s.instruction("date", "old date")
    s.compact(() => kept)
    // Until the new baseline is recorded the old one is in force and the kept message still shows.
    expect(s.input()).toEqual([harness("compaction", "Summary so far."), developer("old date")])
    s.baseline({ ...BASELINE, instructions: "You are a coding agent. The date is known." })
    s.instruction("date", "new date")
    expect(s.input()).toEqual([harness("compaction", "Summary so far."), developer("new date")])
  })
})

describe("assistant messages", () => {
  test("text is assistant text, with the provider's data replayed", () => {
    const s = prompted()
    s.step({ parts: [{ text: "Done.", providerData: { id: "msg_1", phase: "final_answer" } }] })
    expect(s.input().at(-1)).toEqual(said("Done.", { id: "msg_1", phase: "final_answer" }))
  })

  test("a completed step replays reasoning, text and calls in stored order, then one result per call in call order", () => {
    const s = prompted()
    // The script settles calls in reverse order; the results still follow call order.
    s.step({
      parts: [
        { reasoning: "two reads" },
        { text: "Reading both." },
        { call: "call_1", input: '{"path": "a.ts"}', output: "const a = 1" },
        { call: "call_2", name: "shell", input: '{"command":"ls"}', output: "a.ts" },
      ],
    })
    expect(s.input().slice(1)).toEqual([
      thought("two reads"),
      said("Reading both."),
      called("call_1", '{"path": "a.ts"}'),
      called("call_2", '{"command":"ls"}', "shell"),
      result("call_1", "const a = 1"),
      result("call_2", "a.ts"),
    ])
  })

  test("the argument text of a call is sent exactly as the model produced it, valid JSON or not", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", input: '{"path": ', outcome: "error", output: "The arguments are not valid JSON.", started: false }] })
    expect(s.input().slice(1)).toEqual([called("call_1", '{"path": '), result("call_1", "The arguments are not valid JSON.")])
  })

  test.each([
    ["success", true, "const a = 1"],
    ["error", true, "ENOENT: no such file"],
    ["error", false, "The tool is not allowed in this mode."],
    ["not_started", false, "This call was not started because the response was interrupted."],
    ["effect_unknown", true, "The command was started and its outcome is unknown. Inspect before repeating it."],
  ] as const)("a call settled as %s (started: %p) has its stored output as its one result", (outcome, started, output) => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", outcome, started, output }], end: outcome === "success" ? "tool_calls" : "interrupted" })
    expect(s.input().slice(1)).toEqual([called("call_1"), result("call_1", output)])
    expect(providerProblems(s.request())).toEqual([])
  })

  test("a result carries its attachments", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", output: "screenshot taken", attachments: [IMAGE] }] })
    expect(s.input().at(-1)).toEqual(result("call_1", "screenshot taken", [IMAGE]))
  })

  test("a call id reused in a later step stays next to its own result", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", output: "first" }] })
    s.step({ parts: [{ call: "call_1", output: "second" }] })
    expect(s.input().slice(1)).toEqual([called("call_1"), result("call_1", "first"), called("call_1"), result("call_1", "second")])
    expect(providerProblems(s.request())).toEqual([])
  })

  test("a running step renders nothing, whatever it has produced so far", () => {
    const s = prompted()
    const messageId = "ast_open" as MessageId
    s.apply(
      event("step.started", { messageId, attempt: 1, model: MODEL }),
      event("text.ended", { messageId, text: "Reading.", providerData: null }),
      event("tool.called", { messageId, callId: "call_1" as never, name: "read", input: "{}", providerData: null }),
    )
    expect(s.input()).toEqual([user("fix the bug")])
  })

  test("blank assistant text is not sent", () => {
    const s = prompted()
    s.step({ parts: [{ text: "" }, { text: " \n " }, { text: "Done." }] })
    expect(s.input().slice(1)).toEqual([said("Done.")])
  })
})

describe("reasoning", () => {
  test("is dropped when nothing rendered follows it in the same message", () => {
    const s = prompted()
    s.step({ parts: [{ reasoning: "first" }, { text: "Answer." }, { reasoning: "afterthought" }, { text: "  " }] })
    expect(s.input().slice(1)).toEqual([thought("first"), said("Answer.")])
  })

  test("a completed message with nothing but reasoning renders nothing", () => {
    const s = prompted()
    s.step({ parts: [{ reasoning: "hm" }] })
    expect(s.input()).toEqual([user("fix the bug")])
  })

  test("consecutive reasoning parts are all replayed when output follows", () => {
    const s = prompted()
    s.step({ parts: [{ reasoning: "one" }, { reasoning: "two" }, { call: "call_1", output: "ok" }] })
    expect(s.input().slice(1)).toEqual([thought("one"), thought("two"), called("call_1"), result("call_1", "ok")])
  })

  test("is dropped when the provider attached nothing to replay", () => {
    const s = prompted()
    s.step({ parts: [{ reasoning: "summary only", providerData: null }, { text: "Answer." }] })
    expect(s.input().slice(1)).toEqual([said("Answer.")])
  })

  test("is dropped for a request to another model, and provider data is not sent to it", () => {
    const s = prompted()
    s.step({
      parts: [
        { reasoning: "plan" },
        { text: "Reading.", providerData: { id: "msg_1" } },
        { call: "call_1", output: "ok", providerData: { id: "fc_1" } },
      ],
    })
    const other = { params: { ...PARAMS, model: "gpt-other" }, toolChoice: "auto" as const }
    expect(s.input(other).slice(1)).toEqual([said("Reading."), called("call_1"), result("call_1", "ok")])
    expect(s.input().slice(1)).toEqual([
      thought("plan"),
      said("Reading.", { id: "msg_1" }),
      called("call_1", undefined, undefined, { id: "fc_1" }),
      result("call_1", "ok"),
    ])
  })

  test("is dropped from a message produced by another model, and kept in the next one", () => {
    const s = prompted()
    s.step({ model: "gpt-other", parts: [{ reasoning: "theirs" }, { call: "call_1", output: "ok" }] })
    s.step({ parts: [{ reasoning: "mine" }, { text: "Done." }] })
    expect(s.input().slice(1)).toEqual([called("call_1"), result("call_1", "ok"), thought("mine"), said("Done.")])
  })
})

describe("failed and retried steps", () => {
  test("a step that failed before any output renders nothing, and a retry under the same message sends the same request", () => {
    const s = prompted()
    const before = canonicalJson(s.request())
    const messageId = "ast_retry" as MessageId
    s.apply(event("step.started", { messageId, attempt: 1, model: MODEL }))
    expect(canonicalJson(s.request())).toBe(before)
    s.retry(messageId, 2)
    expect(canonicalJson(s.request())).toBe(before)
    s.apply(event("step.failed", { messageId, error: { kind: "crashed" }, usage: null }))
    expect(canonicalJson(s.request())).toBe(before)
  })

  test("a step that failed after output keeps its text and calls, loses its reasoning, and the continuation follows", () => {
    const s = prompted()
    const failed = s.step({
      parts: [{ reasoning: "first" }, { text: "Reading." }, { call: "call_1", output: "const a = 1" }],
      end: "provider_error",
    })
    s.retry(failed, 2)
    const atRetry = s.hashes()
    s.step({ attempt: 2, parts: [{ reasoning: "again" }, { text: "Done." }] })
    expect(s.input().slice(1)).toEqual([
      said("Reading."),
      called("call_1"),
      result("call_1", "const a = 1"),
      thought("again"),
      said("Done."),
    ])
    expect(comparePrefix(atRetry, s.hashes())).toEqual({ extension: true, appended: 2 })
  })

  test("a failed message never ends in reasoning", () => {
    const s = prompted()
    s.step({ parts: [{ text: "Let me think." }, { reasoning: "cut off" }], end: "interrupted" })
    expect(s.input().slice(1)).toEqual([said("Let me think.")])
    expect(providerProblems(s.request())).toEqual([])
  })

  test("an interrupted step shows every call with the result it settled with", () => {
    const s = prompted()
    s.step({
      parts: [
        { reasoning: "plan" },
        { call: "call_1", output: "done" },
        { call: "call_2", outcome: "effect_unknown", output: "unknown effect" },
        { call: "call_3", outcome: "not_started", output: "not started" },
      ],
      end: "interrupted",
    })
    expect(s.input().slice(1)).toEqual([
      called("call_1"),
      called("call_2"),
      called("call_3"),
      result("call_1", "done"),
      result("call_2", "unknown effect"),
      result("call_3", "not started"),
    ])
  })

  test("a crashed step is rendered like any other failed step", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1", outcome: "effect_unknown", output: "unknown effect" }], end: "crashed" })
    expect(s.input().slice(1)).toEqual([called("call_1"), result("call_1", "unknown effect")])
  })
})

describe("excluded ranges", () => {
  test("a refused step and everything from the excluded seq on are left out", () => {
    const s = prompted("first")
    s.step({ parts: [{ text: "One." }] })
    s.release()
    const second = s.user("refused prompt")
    s.step({ parts: [{ call: "call_1" }] })
    s.step({ parts: [{ text: "I" }], end: { refusedFrom: second } })
    expect(s.input()).toEqual([user("first"), said("One.")])
  })

  test("a refused message renders nothing even where the exclusion did not reach", () => {
    const refused = { kind: "assistant", status: "refused", model: MODEL, parts: [{ type: "text", text: "I", providerData: null }] }
    expect(renderMessage(refused as unknown as AssistantMessage, { model: MODEL, baselineSeq: 1 })).toEqual([])
  })

  test("reverted messages are left out and later messages follow what remains", () => {
    const s = prompted("first")
    s.step({ parts: [{ text: "One." }] })
    s.release()
    const second = s.user("second")
    s.step({ parts: [{ text: "Two." }] })
    s.release()
    s.revert(second)
    s.user("second, differently")
    expect(s.input()).toEqual([user("first"), said("One."), user("second, differently")])
  })
})

describe("compaction", () => {
  test("the checkpoint comes first as a harness message, then the kept messages by the usual rules", () => {
    const s = prompted("first")
    s.step({ parts: [{ call: "call_1", output: "old" }] })
    const kept = s.user("second")
    s.step({ parts: [{ reasoning: "r" }, { call: "call_1", output: "new" }] })
    s.compact(() => kept, "The user asked for a fix; a.ts was read.")
    s.step({ parts: [{ text: "Continuing." }] })
    expect(s.input()).toEqual([
      harness("compaction", "The user asked for a fix; a.ts was read."),
      user("second"),
      thought("r"),
      called("call_1"),
      result("call_1", "new"),
      said("Continuing."),
    ])
    expect(providerProblems(s.request())).toEqual([])
  })

  test("a running or failed compaction changes nothing", () => {
    const s = prompted()
    s.step({ parts: [{ text: "One." }] })
    const before = canonicalJson(s.request())
    const messageId = "cmp_x" as MessageId
    s.apply(event("compaction.started", { messageId, trigger: "manual" }))
    expect(canonicalJson(s.request())).toBe(before)
    s.apply(event("compaction.failed", { messageId, error: { kind: "crashed" } }))
    expect(canonicalJson(s.request())).toBe(before)
  })

  test("only the latest completed compaction is the checkpoint", () => {
    const s = prompted()
    s.step({ parts: [{ text: "One." }] })
    s.compact((seq) => seq, "first summary")
    s.step({ parts: [{ text: "Two." }] })
    s.compact((seq) => seq, "second summary")
    expect(s.input()).toEqual([harness("compaction", "second summary")])
  })

  test("the compaction request is the step request plus one developer prompt, with tool calls off", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1" }] })
    const step = s.request()
    const compaction = buildCompactionRequest(s.projection, PARAMS, "Summarise the conversation so far.")
    expect(comparePrefix(hashRequest(step), hashRequest(compaction))).toEqual({ extension: true, appended: 1 })
    expect(compaction.input.at(-1)).toEqual(developer("Summarise the conversation so far."))
    expect(compaction.tools).toEqual(step.tools)
    expect(compaction.toolChoice).toBe("none")
  })
})

describe("states the reducer cannot produce", () => {
  const corrupt = (change: (projection: Projection) => Projection) => () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1" }] })
    s.compact((seq) => seq)
    return buildRequest(change(s.projection), OPTIONS)
  }

  test("a closed message with an unsettled call is an error, not a guess", () => {
    const s = prompted()
    s.step({ parts: [{ call: "call_1" }] })
    const messages = s.projection.messages.map((message) =>
      message.kind !== "assistant"
        ? message
        : { ...message, parts: message.parts.map((part) => (part.type === "tool_call" ? { ...part, state: { status: "running" as const, effect: "read" as const } } : part)) },
    )
    expect(() => buildRequest({ ...s.projection, messages }, OPTIONS)).toThrow("tool call call_1")
  })

  test("a checkpoint without a summary is an error", () => {
    const build = corrupt((projection) => ({
      ...projection,
      messages: projection.messages.map((message) => (message.kind === "compaction" ? { ...message, summary: null } : message)),
    }))
    expect(build).toThrow(RequestBuildError)
  })
})

describe("the builder as a function", () => {
  test("it does not modify the projection", () => {
    const s = prompted()
    s.step({ parts: [{ reasoning: "r" }, { call: "call_1" }] })
    s.harness("check", "ok")
    const before = JSON.stringify(s.projection)
    s.request()
    expect(JSON.stringify(s.projection)).toBe(before)
  })

  test("buildRequestFromHistory takes the model's view directly", () => {
    const s = prompted()
    s.step({ parts: [{ text: "One." }] })
    const direct = buildRequestFromHistory({ baseline: s.projection.baseline, messages: s.projection.messages }, OPTIONS)
    expect(canonicalJson(direct)).toBe(canonicalJson(s.request()))
  })

  test("a fork's first request is its parent's request at the fork point", () => {
    const parent = prompted()
    parent.step({ parts: [{ call: "call_1" }] })
    parent.step({ parts: [{ text: "Done." }] })
    parent.release()
    const fork = reduce(parent.projection, {
      ...event("session.created", {
        cwd: "/repo",
        title: null,
        lineage: { kind: "fork", parentSessionId: parent.sessionId, throughSeq: parent.seq },
      }),
      sessionId: "ses_fork" as SessionId,
      seq: parent.seq + 1,
      time: 0,
    })
    expect(canonicalJson(buildRequest(fork, OPTIONS))).toBe(canonicalJson(parent.request()))
  })

  test("the golden request: every kind of message in one session, block by block", () => {
    const s = new Script().open()
    s.user("fix the bug in a.ts")
    s.step({ parts: [{ reasoning: "read it" }, { text: "Reading." }, { call: "call_1", output: "const a = 1" }] })
    s.instruction("date", "The date has changed.")
    s.step({ parts: [{ call: "call_1", name: "shell", input: '{"command":"bun test"}', outcome: "error", output: "1 fail" }] })
    s.background("background-command", "Command 1 finished.")
    s.step({ parts: [{ text: "Almost" }], end: "interrupted" })
    s.interruptExecution()
    s.harness("interrupt", "Your previous response was interrupted by the user.")
    s.user("carry on")
    s.step({ parts: [{ text: "Fixed." }] })
    s.release()
    expect(requestBlocks(s.request())).toEqual([
      { kind: "params", params: PARAMS },
      { kind: "tool", tool: READ },
      { kind: "tool", tool: SHELL },
      { kind: "instructions", text: "You are a coding agent." },
      ...[
        user("fix the bug in a.ts"),
        { type: "reasoning" as const, text: "read it", providerData: ENCRYPTED },
        said("Reading."),
        called("call_1"),
        result("call_1", "const a = 1"),
        developer("The date has changed."),
        called("call_1", '{"command":"bun test"}', "shell"),
        result("call_1", "1 fail"),
        harness("background-command", "Command 1 finished."),
        said("Almost"),
        harness("interrupt", "Your previous response was interrupted by the user."),
        user("carry on"),
        said("Fixed."),
      ].map((item) => ({ kind: "input" as const, item })),
    ])
    expect(providerProblems(s.request())).toEqual([])
  })

  test("content built with the text helper and content read from rows hash the same", () => {
    const s = prompted()
    const reread = JSON.parse(JSON.stringify(s.projection)) as Projection
    expect(hashRequest(buildRequest(reread, OPTIONS))).toEqual(s.hashes())
    expect(s.input()).toEqual([{ type: "message", role: "user", content: text("fix the bug") }])
  })
})
