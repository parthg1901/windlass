/**
 * Retiring images at a compaction (`context/images.ts`): which results of the kept part lose their images, the
 * line each gets, and the list the checkpoint carries for the images before the cut.
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_CHECKPOINT_LIMITS, buildCheckpoint } from "../../src/context/checkpoint.ts"
import { estimateTokens, MEDIA_TOKENS } from "../../src/context/estimate.ts"
import { IMAGES_ADVICE, IMAGES_HEADING, IMAGE_RETIREMENT, renderImages, retireImages, retirementSaves } from "../../src/context/images.ts"
import { DEFAULT_COMPACTION_CONFIG } from "../../src/context/policy.ts"
import type { BlobRef } from "../../src/content.ts"
import type { AssistantMessage, Message } from "../../src/message/message.ts"
import { type CallSpec, Script, read } from "./fixtures.ts"

const PNG: BlobRef = { hash: "a".repeat(64), mediaType: "image/png" }
const JPEG: BlobRef = { hash: "b".repeat(64), mediaType: "image/jpeg" }

/** A `read` of an image file as the tool settles it: one line, the image attached, and what it reports for a client. */
const shot = (path: string, bytes = 2048): CallSpec & { attachments: BlobRef[]; display: unknown } => ({
  name: "read",
  input: { path },
  output: `${path}: PNG image (image/png), 640x480 pixels, ${bytes} bytes, attached.`,
  attachments: [PNG],
  display: { path, image: { mediaType: "image/png", width: 640, height: 480, bytes } },
})
/** An MCP result with two images and no file. */
const screenshots: CallSpec & { attachments: BlobRef[] } = {
  name: "mcp_call",
  input: { server: "browser", tool: "screenshot", arguments: {} },
  output: "[image image/png, 900 bytes, attached]\n[image image/jpeg, 700 bytes, attached]",
  attachments: [PNG, JPEG],
}

/** The script's messages with the attachments and display of each call put on its settled result. */
function withImages(script: Script, calls: Record<string, { attachments: BlobRef[]; display?: unknown }>): Message[] {
  return script.messages.map((message) => {
    if (message.kind !== "assistant") return message
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.type !== "tool_call" || part.state.status !== "settled") return part
        const path = (JSON.parse(part.input) as { path?: string }).path ?? part.name
        const found = calls[path]
        return found === undefined ? part : { ...part, state: { ...part.state, attachments: found.attachments, display: (found.display ?? null) as never } }
      }),
    } satisfies AssistantMessage
  })
}

/** Five steps that each read an image, then one that reads a text file; `tail` adds what comes after. */
function session(tail: (script: Script) => Script = (script) => script): Message[] {
  const script = new Script().user("Compare the screenshots.")
  for (const name of ["one", "two", "three", "four", "five"]) script.step({ calls: [shot(`${name}.png`)] })
  tail(script)
  return withImages(script, Object.fromEntries(["one", "two", "three", "four", "five", "six"].map((name) => [`${name}.png`, shot(`${name}.png`)])))
}

const paths = (messages: readonly Message[], retired: readonly { messageId: string }[]) =>
  retired.map((entry) => {
    const message = messages.find((candidate) => candidate.id === entry.messageId) as AssistantMessage
    const part = message.parts.find((candidate) => candidate.type === "tool_call")!
    return part.type === "tool_call" ? (JSON.parse(part.input) as { path: string }).path : ""
  })

describe("retireImages", () => {
  test("the last step's images stay, then the most recent up to the limit; every older result is retired, oldest first", () => {
    const kept = session()
    const retired = retireImages({ kept, previous: [], keepRecent: IMAGE_RETIREMENT.keepRecent })
    // five.png is unanswered and four.png is the second most recent: two stay.
    expect(paths(kept, retired)).toEqual(["one.png", "two.png", "three.png"])
    expect(retired[0]).toEqual({
      messageId: kept[1]!.id,
      callId: "call_2_0" as never,
      images: 1,
      note: "\n[The image of this result is no longer attached: it was taken out of the conversation when it was compacted, to save context. To see it again, read one.png again.]",
    })
  })

  test("after the model answered, no step is unanswered: only the limit decides", () => {
    const kept = session((script) => script.step({ text: "They differ in the header." }).user("And the footer?"))
    expect(paths(kept, retireImages({ kept, previous: [], keepRecent: 2 }))).toEqual(["one.png", "two.png", "three.png"])
    expect(paths(kept, retireImages({ kept, previous: [], keepRecent: 0 }))).toEqual(["one.png", "two.png", "three.png", "four.png", "five.png"])
    expect(retireImages({ kept, previous: [], keepRecent: 5 })).toEqual([])
  })

  test("an aggressive compaction keeps only what the model has not been shown, however many images that is", () => {
    const script = new Script().user("Look.").step({ calls: [shot("one.png")] }).step({ calls: [screenshots, shot("two.png")] })
    const kept = withImages(script, { "one.png": shot("one.png"), "two.png": shot("two.png"), mcp_call: screenshots })
    expect(paths(kept, retireImages({ kept, previous: [], keepRecent: IMAGE_RETIREMENT.keepRecentAggressive }))).toEqual(["one.png"])
  })

  test("a result with several images is kept or retired whole, and a call that names no file says to call the tool again", () => {
    const script = new Script().user("Look.").step({ calls: [screenshots] }).step({ calls: [shot("one.png")] }).step({ text: "Seen." }).user("Go on.")
    const kept = withImages(script, { "one.png": shot("one.png"), mcp_call: screenshots })
    // one.png is the most recent; the two screenshots would make three.
    const retired = retireImages({ kept, previous: [], keepRecent: 2 })
    expect(retired).toMatchObject([
      { images: 2, note: "\n[The 2 images of this result are no longer attached: they were taken out of the conversation when it was compacted, to save context. To see them again, call mcp_call again with the same arguments.]" },
    ])
    // Once a result does not fit, nothing older is kept either, even where it would fit by itself.
    const older = withImages(new Script().user("Look.").step({ calls: [shot("one.png")] }).step({ calls: [screenshots] }).step({ calls: [shot("two.png")] }).step({ text: "Seen." }), {
      "one.png": shot("one.png"),
      "two.png": shot("two.png"),
      mcp_call: screenshots,
    })
    expect(retireImages({ kept: older, previous: [], keepRecent: 2 }).map((entry) => entry.images)).toEqual([1, 2])
  })

  test("what the compaction in force retired stays retired with the same line, and counts for nothing", () => {
    const kept = session()
    const first = retireImages({ kept, previous: [], keepRecent: 0 })
    expect(paths(kept, first)).toEqual(["one.png", "two.png", "three.png", "four.png"])
    const frozen = first.map((entry) => ({ ...entry, note: `${entry.note} (as it was frozen)` }))
    // A later compaction with a larger limit: nothing comes back, and the lines are the recorded ones.
    const later = session((script) => script.step({ calls: [shot("six.png")] }))
    const second = retireImages({ kept: later, previous: frozen, keepRecent: 4 })
    expect(second.slice(0, 4)).toEqual(frozen)
    // six.png is unanswered and five.png fits; nothing new is retired.
    expect(second).toHaveLength(4)
    // What the retired results take off the kept part as it is counted from the stored messages: their images, less their lines.
    expect(retirementSaves(first, MEDIA_TOKENS)).toBe(first.reduce((sum, entry) => sum + MEDIA_TOKENS - estimateTokens(entry.note), 0))
    expect(retirementSaves([], MEDIA_TOKENS)).toBe(0)
  })

  test("results of a step that is running, and results without an image, are left alone", () => {
    const script = new Script().user("Look.").step({ calls: [read("a.ts", "export const a = 1")] }).step({ calls: [shot("one.png")], status: "running" }).step({ text: "Seen." })
    const kept = withImages(script, { "one.png": shot("one.png") })
    expect(retireImages({ kept, previous: [], keepRecent: 0 })).toEqual([])
  })
})

describe("the checkpoint's list of images", () => {
  test("names each file with its type and size and where it was read, once, and says how to see it again", () => {
    const earlier = withImages(new Script().user("Look.").step({ calls: [shot("docs/one.png", 4096)] }).step({ calls: [screenshots] }).step({ calls: [shot("docs/one.png", 5000)] }), {
      "docs/one.png": shot("docs/one.png", 5000),
      mcp_call: screenshots,
    })
    expect(renderImages(earlier, 200, 160)).toBe(
      [
        IMAGES_HEADING,
        IMAGES_ADVICE,
        "- 2 images (image/png, image/jpeg) returned by mcp_call at seq 3",
        "- docs/one.png (image/png, 640x480 pixels, 5000 bytes), read at seq 4",
      ].join("\n"),
    )
    expect(IMAGES_ADVICE).toContain("read its file again")
    expect(renderImages(new Script().user("No images.").step({ calls: [read("a.ts", "1")] }).messages, 200, 160)).toBe("")
  })

  test("is bounded: the most recent images are listed and the rest are counted", () => {
    const script = new Script().user("Look.")
    const calls: Record<string, ReturnType<typeof shot>> = {}
    for (let index = 0; index < 40; index += 1) {
      const path = `screenshots/run-${index}/page-after-the-click.png`
      calls[path] = shot(path)
      script.step({ calls: [calls[path]!] })
    }
    const text = renderImages(withImages(script, calls), DEFAULT_CHECKPOINT_LIMITS.imageTokens, DEFAULT_CHECKPOINT_LIMITS.entryChars)
    expect(estimateTokens(text)).toBeLessThanOrEqual(DEFAULT_CHECKPOINT_LIMITS.imageTokens)
    expect(text).toContain("run-39/")
    expect(text).not.toContain("run-0/")
    expect(text).toMatch(/\(\d+ images shown before those are not listed\.\)/)
  })

  test("the checkpoint carries it after the identifier index, within the bound of its mechanical part", () => {
    const script = new Script().user("Compare the screenshots.")
    const calls: Record<string, ReturnType<typeof shot>> = {}
    for (let index = 0; index < 60; index += 1) {
      const path = `screenshots/run-${index}/page.png`
      calls[path] = shot(path)
      script.step({ calls: [calls[path]!, read(`src/module-${index}/index.ts`, `export const value${index} = ${index}`)] })
      script.user(`Now look at run ${index + 1}. ${"It should match the design exactly. ".repeat(30)}`)
    }
    const checkpoint = buildCheckpoint({ summary: "", earlier: withImages(script, calls) })
    expect(checkpoint.text).toContain(`${IMAGES_HEADING}\n${IMAGES_ADVICE}`)
    expect(checkpoint.text.indexOf("## Exact identifiers")).toBeLessThan(checkpoint.text.indexOf(IMAGES_HEADING))
    expect(checkpoint.text.indexOf(IMAGES_HEADING)).toBeLessThan(checkpoint.text.indexOf("## The user's messages"))
    expect(checkpoint.tokens).toBeLessThanOrEqual(DEFAULT_COMPACTION_CONFIG.checkpointExtraMaxTokens)
  })
})
