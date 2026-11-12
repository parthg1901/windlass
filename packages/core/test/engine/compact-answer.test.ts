/**
 * What `compact()` answers when it does not compact because too little could be summarised.
 *
 * A compaction keeps part of the conversation word for word, and only what is before that part is summarised.
 * When that is less than a checkpoint would take, nothing is compacted. The answer says how little could be
 * summarised, and what keeps the rest, in a sentence the user can act on: the conversation's recent part fits
 * what a compaction keeps anyway (ask again when it has grown); or the rest is what the next request has to
 * answer (ask again after it); or there is no more (the conversation is short).
 */
import { afterAll, expect, test } from "bun:test"
import { estimateTokens } from "../../src/context/estimate.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { measured } from "../scenarios/script.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"

afterAll(removeHarnessDirectories)

const at = (inputTokens: number) => script.usage(measured(inputTokens))
/** Text of about `tokens` tokens, as the estimator counts them. */
function textOf(tokens: number): string {
  const lines: string[] = []
  for (let index = 0, spent = 0; spent < tokens; index += 1) {
    const line = `${index + 1}\texport const setting${index} = readSetting("section.${index}")`
    lines.push(line)
    spent += estimateTokens(`${line}\n`)
  }
  return lines.join("\n")
}
const message = (result: Awaited<ReturnType<Harness["session"]["compact"]>>) => (result.kind === "nothing" ? result.message : `(${result.kind})`)

test("a conversation whose recent part is nearly all of it: the answer should say that this part is kept word for word, how much a compaction keeps, and what to do", async () => {
  const h = new Harness({ contextWindow: 272_000 })
  try {
    // A short first turn, then one that reads four files: about 42,000 tokens of conversation, of which a compaction
    // keeps the most recent 41,000 or so word for word in a window of this size. Only the first turn is before that.
    h.tools.on("read", textOf(31_000), textOf(31_000), textOf(31_000), textOf(1_000))
    h.provider.enqueue(
      [script.text(textOf(1_500)), at(3_000)],
      [script.toolCall("call_1", "read", { path: "a.ts" }), at(5_000)],
      [script.toolCall("call_1", "read", { path: "b.ts" }), at(18_000)],
      [script.toolCall("call_1", "read", { path: "c.ts" }), at(31_000)],
      [script.toolCall("call_1", "read", { path: "d.ts" }), at(44_000)],
      [script.text("They define the settings."), at(45_000)],
    )
    h.create().send("List the settings.")
    await h.settled()
    h.session.send("What is in a.ts, b.ts, c.ts and d.ts?")
    await h.settled()
    const before = h.log().length
    const answer = message(await h.session.compact())
    expect(answer).toMatch(
      /^Not compacted: only about 1,\d{3} tokens of the conversation could be summarised, and a checkpoint takes about as much\. The other 4\d,\d{3} tokens are the most recent part of the conversation, which a compaction keeps word for word \(up to about 4\d,\d{3} tokens with this model's context window\), so there is nothing to gain yet: ask again when the conversation has grown\. A compaction is worth it from about 2,000 tokens\.$/,
    )
    expect(h.log()).toHaveLength(before)
  } finally {
    await h.dispose()
  }
})

test("a conversation that is all recent part: the answer should say that, not that the next request needs all of it", async () => {
  const h = new Harness({ contextWindow: 272_000 })
  try {
    h.tools.on("read", textOf(31_000))
    h.provider.enqueue([script.toolCall("call_1", "read", { path: "settings.ts" }), at(2_000)], [script.text("It defines the settings."), at(15_000)])
    h.create().send("What is in settings.ts?")
    await h.settled()
    expect(message(await h.session.compact())).toMatch(
      /^There is nothing to compact yet: the whole conversation, about 1\d,\d{3} tokens, is within what a compaction keeps word for word \(up to about 4\d,\d{3} tokens with this model's context window\)\. Ask again when the conversation has grown\.$/,
    )
  } finally {
    await h.dispose()
  }
})

test("what the next request has to answer is kept, and the answer says so: the model's last response, or input it has not answered", async () => {
  // No window is known, so a compaction keeps only what the next request answers.
  const h = new Harness()
  try {
    h.provider.enqueue([script.text(textOf(3_000)), at(3_500)])
    h.create().send("List the settings.")
    await h.settled()
    expect(message(await h.session.compact())).toMatch(
      /^Not compacted: only about \d+ tokens of the conversation could be summarised, and a checkpoint takes about as much\. The other \d,\d{3} tokens are the model's last response with the results of its calls, which is kept word for word because the next request answers it: ask again after the next turn\. A compaction is worth it from about 2,000 tokens\.$/,
    )
  } finally {
    await h.dispose()
  }
})

test("a short conversation is said to be short", async () => {
  const h = new Harness()
  try {
    h.provider.enqueue([script.text("Hello."), at(900)])
    h.create().send("Hi.")
    await h.settled()
    expect(message(await h.session.compact())).toMatch(
      /^Not compacted: only about \d+ tokens of the conversation could be summarised, and a checkpoint takes about as much\. The conversation is short: about \d+ tokens in all\. A compaction is worth it from about 2,000 tokens\.$/,
    )
  } finally {
    await h.dispose()
  }
})
