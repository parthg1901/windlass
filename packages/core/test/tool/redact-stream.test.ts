import { describe, expect, test } from "bun:test"
import { redact, redactPieces, unfinishedSecret } from "../../src/approval/redact.ts"
import { redactingStream } from "../../src/tool/redact-stream.ts"

const SECRET = "EXAMPLE_VALUE_123"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Feeds `chunks` through a stream and records what came out after each chunk. */
function run(chunks: readonly string[], options: { secrets?: readonly string[]; exact?: boolean; maxHeld?: number } = {}) {
  const secrets = options.secrets ?? [SECRET]
  const emitted: string[] = []
  const stream = redactingStream(
    { redact: (text) => redactPieces(text, secrets), ...(options.exact === false ? {} : { unfinishedSecret: (text: string) => unfinishedSecret(text, secrets) }) },
    (bytes) => emitted.push(decoder.decode(bytes)),
    options.maxHeld,
  )
  const after: string[] = []
  for (const chunk of chunks) {
    stream.write(encoder.encode(chunk))
    after.push(emitted.join(""))
  }
  stream.end()
  return { after, all: emitted.join("") }
}

/** Every way of cutting `text` in two. */
function splits(text: string) {
  return Array.from({ length: text.length - 1 }, (_, index) => [text.slice(0, index + 1), text.slice(index + 1)])
}

describe("unfinishedSecret", () => {
  test("finds the longest ending that begins a value", () => {
    expect(unfinishedSecret("output EXAMPLE_VA", [SECRET])).toBe(7)
    expect(unfinishedSecret("output E", [SECRET])).toBe(7)
    expect(unfinishedSecret("output", [SECRET])).toBe(6)
    // The whole value is no longer unfinished: the redaction replaces it.
    expect(unfinishedSecret(`x ${SECRET}`, [SECRET])).toBe(2 + SECRET.length)
    // A value that repeats its own beginning: the longest ending wins.
    expect(unfinishedSecret("abababab", ["abababac"])).toBe(2)
    // Values too short to be redacted are not held either.
    expect(unfinishedSecret("short", ["shorter"])).toBe(5)
  })
})

describe("redactingStream", () => {
  test("a value split between two chunks at any point never comes out, in part or whole", () => {
    for (const exact of [true, false]) {
      for (const [first, second] of splits(`before ${SECRET} after\n`)) {
        const { after, all } = run([first!, second!], { exact })
        expect(all).toBe(redact(`before ${SECRET} after\n`, [SECRET]).text)
        // What was passed on after the first chunk holds no beginning of the value longer than a couple of characters.
        expect(after[0]!).not.toContain("EXAM")
      }
    }
  })

  test("a value split byte by byte, also inside a multi-byte character", () => {
    const text = `é ${SECRET} ü\n`
    const bytes = encoder.encode(text)
    const emitted: string[] = []
    const stream = redactingStream({ redact: (part) => redactPieces(part, [SECRET]) }, (out) => emitted.push(decoder.decode(out)))
    for (const byte of bytes) stream.write(new Uint8Array([byte]))
    stream.end()
    expect(emitted.join("")).toBe("é [REDACTED:env] ü\n")
  })

  test("an unfinished line is held, finished lines are passed on", () => {
    // The beginning of a pattern (`-----BEGIN RSA PRI`) matches nothing yet, so the line is held with or without the exact check.
    for (const exact of [true, false]) expect(run(["done\nprogress 40% EXAMPLE_VAL"], { exact }).after[0]).toBe("done\n")
  })

  test("a value with a line break in it is held whole with the exact check", () => {
    const value = "EXAMPLE_FIRST_LINE\nEXAMPLE_SECOND_LINE"
    const { after, all } = run(["head\nEXAMPLE_FIRST_LINE\n", "EXAMPLE_SECOND_LINE\ntail\n"], { secrets: [value] })
    expect(after[0]).toBe("head\n")
    expect(all).toBe("head\n[REDACTED:env]\ntail\n")
  })

  test("a token that may still grow and an unterminated private key block are held until they end", () => {
    const token = `sk-${"a".repeat(30)}`
    const first = run([`key ${token.slice(0, 12)}`, `${token.slice(12)} done\n`], { secrets: [] })
    expect(first.all).toBe("key [REDACTED:openai-key] done\n")
    const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEexampleexample\nMIIEexampleexample\n-----END RSA PRIVATE KEY-----\n"
    const cut = block.indexOf("MIIE") + 4
    const second = run([`x\n${block.slice(0, cut)}`, block.slice(cut, -10), `${block.slice(-10)}y\n`], { secrets: [] })
    expect(second.after[0]).toBe("x\n")
    expect(second.after[1]).toBe("x\n")
    expect(second.all).toBe("x\n[REDACTED:private-key]\ny\n")
  })

  test("a line longer than the limit is passed on except its end, cut between words", () => {
    const words = Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ")
    const { after, all } = run([words], { maxHeld: 100, secrets: [] })
    expect(after[0]!.length).toBeGreaterThan(words.length - 100)
    expect(after[0]!.endsWith(" ")).toBe(true)
    expect(all).toBe(words)
  })
})
