/**
 * Images across two compactions, through the real loop.
 *
 * `compaction.ended.retired` is what every request after a compaction is built from: the kept results whose
 * images are no longer sent, each with the line that follows its stored output. A second compaction that still
 * keeps such a result carries it on with the same line (an image never comes back by itself, and a line that was
 * sent never changes), and retires the next oldest by the same rule. Between the compactions, and after the
 * second, every step request extends the one before it.
 *
 * The scenario "Old images are retired at a compaction, and at no other time" (test/scenarios/compaction.ts) has
 * the first compaction event by event; `test/context/images.test.ts` has the rule.
 */
import { afterAll, expect, test } from "bun:test"
import { estimateRequest, estimateTokens } from "../../src/context/estimate.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import { buildRequest } from "../../src/request/build.ts"
import { script } from "../../src/testing/fake-provider.ts"
import type { ToolContext, ToolResult } from "../../src/tool/tool.ts"
import { RETIRED_NOTE, imageBlob, imageBytes, imageDisplay, imageOutput } from "../scenarios/compaction.ts"
import { SUMMARY, measured } from "../scenarios/script.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const at = (inputTokens: number) => script.usage(measured(inputTokens))
const readsAt = (path: string, inputTokens: number) => [script.toolCall("call_1", "read", { path }), at(inputTokens)]
/** The scripted `read` tool on an image file: the result carries the image, stored as the real tool stores it. */
const showsImage = (input: Record<string, unknown>, context: ToolContext): ToolResult => {
  const path = String(input.path)
  return { status: "success", output: imageOutput(path), truncation: null, attachments: [context.putBlob(imageBytes(path), "image/png")], display: imageDisplay(path) }
}
/** A text file of about `tokens` tokens, as the estimator counts them. */
function textOf(tokens: number): string {
  const lines: string[] = []
  for (let index = 0, spent = 0; spent < tokens; index += 1) {
    const line = `${index + 1}\texport const setting${index} = readSetting("section.${index}")`
    lines.push(line)
    spent += estimateTokens(`${line}\n`)
  }
  return lines.join("\n")
}

const ended = (log: readonly StoredEvent[]) => log.filter((item): item is StoredEvent<"compaction.ended"> => item.type === "compaction.ended")
const results = (input: ReturnType<typeof buildRequest>["input"]) => input.flatMap((item) => (item.type === "tool_result" ? [item] : []))

test("a second compaction should carry a retirement on with the same line and retire the next oldest image, and nothing should change in between", async () => {
  // A window in which a compaction keeps about 15,000 tokens word for word: several steps, so that the second
  // compaction still keeps a result the first one retired.
  const h = new Harness({ contextWindow: 60_000 })
  try {
    h.provider.enqueue(
      readsAt("build.log", 10_000),
      readsAt("notes.txt", 15_000),
      readsAt("one.png", 20_000),
      readsAt("two.png", 25_000),
      readsAt("three.png", 47_000),
      [script.text(SUMMARY)],
      readsAt("styles.css", 25_000),
      readsAt("four.png", 47_000),
      [script.text(SUMMARY)],
      [script.text("The dialog is open in four.png only."), at(20_000)],
    )
    h.tools.on("read", textOf(20_000), textOf(9_000), showsImage, showsImage, showsImage, textOf(5_000), showsImage)
    h.create().send("Find the screenshot with the dialog open.")
    await h.settled()

    const log = h.log()
    expect(log.at(-1)?.type).toBe("execution.succeeded")
    const [first, second] = ended(log)
    const stepOf = (path: string) => h.session.projection().messages.find((message) => message.kind === "assistant" && message.parts.some((part) => part.type === "tool_call" && part.input.includes(path)))!.id
    // The first keeps notes.txt and the three screenshots: three.png is unanswered, two.png is the second most recent, one.png goes.
    expect(first!.data.retired).toEqual([{ messageId: stepOf("one.png"), callId: "call_1" as never, images: 1, note: RETIRED_NOTE("one.png") }])
    // The second keeps everything from one.png on. one.png stays retired, with the line as it was frozen; four.png is
    // unanswered and three.png the second most recent, so two.png is retired now.
    expect(second!.data.retired).toEqual([
      { messageId: stepOf("one.png"), callId: "call_1" as never, images: 1, note: RETIRED_NOTE("one.png") },
      { messageId: stepOf("two.png"), callId: "call_1" as never, images: 1, note: RETIRED_NOTE("two.png") },
    ])

    const requests = h.provider.requests
    // Calls: 0-4 the first five steps, 5 the first summary, 6-7 two steps, 8 the second summary, 9 the answer.
    expect(requests).toHaveLength(10)
    const images = (index: number) => results(requests[index]!.input).map((item) => item.attachments.length)
    // Before the first compaction every image is sent again with every request.
    expect(images(4)).toEqual([0, 0, 1, 1])
    // After it: notes.txt, then one.png without its image and with the line, two.png and three.png as they were.
    expect(images(6)).toEqual([0, 0, 1, 1])
    expect(results(requests[6]!.input)[1]).toEqual({ type: "tool_result", callId: "call_1", output: imageOutput("one.png") + RETIRED_NOTE("one.png"), attachments: [] })
    // Between the compactions nothing changes: each step request is the one before it plus appended items.
    expect(requests[7]!.input.slice(0, requests[6]!.input.length)).toEqual([...requests[6]!.input])
    // After the second: one.png and two.png without, three.png, styles.css, four.png.
    expect(images(9)).toEqual([0, 0, 1, 0, 1])
    expect(results(requests[9]!.input).slice(0, 2).map((item) => item.output)).toEqual([imageOutput("one.png") + RETIRED_NOTE("one.png"), imageOutput("two.png") + RETIRED_NOTE("two.png")])
    expect(results(requests[9]!.input)[2]).toEqual({ type: "tool_result", callId: "call_1", output: imageOutput("three.png"), attachments: [imageBlob("three.png")] })
    // The only requests that do not extend the one before them are the two summary requests and the request after each.
    expect(h.provider.prefixBreaks().map((found) => found.callIndex)).toEqual([5, 6, 8, 9])
    // The size recorded for the request after a compaction is that request's: a retired image is counted no more.
    // (Within a few tokens: the two are summed in a different order.)
    expect(Math.abs(first!.data.tokensAfter - estimateRequest(requests[6]!))).toBeLessThan(8)
    expect(Math.abs(second!.data.tokensAfter - estimateRequest(requests[9]!))).toBeLessThan(8)
    // Rebuilt from the log alone, the next request is the one the loop would send: the record is all it needs.
    h.verify()
    const rebuilt = buildRequest(h.session.projection(), { toolChoice: "auto" })
    expect(results(rebuilt.input).map((item) => item.attachments.length)).toEqual([0, 0, 1, 0, 1])
  } finally {
    await h.dispose()
  }
})
