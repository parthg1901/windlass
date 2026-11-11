import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { OUTPUT_LIMITS, capOutput, countLines, renderCapped } from "../../src/tool/cap.ts"
import { tempDir } from "../tools/helpers.ts"

const bytes = (text: string) => Buffer.byteLength(text)

function lines(count: number, make = (n: number) => `line ${n}`) {
  return Array.from({ length: count }, (_, index) => `${make(index + 1)}\n`).join("")
}

describe("output cap", () => {
  test("text within the limits is returned unchanged and not spilled", async () => {
    const dir = tempDir()
    const text = lines(OUTPUT_LIMITS.maxLines)
    expect(await capOutput(text, dir)).toEqual({ output: text, truncation: null })
    expect(existsSync(`${dir}/x`)).toBe(false)
  })

  test("too many lines keeps a head and a tail on line boundaries, with a marker and a spill file", async () => {
    const dir = tempDir()
    const text = lines(5000)
    const result = await capOutput(text, dir)
    const out = result.output.split("\n")
    expect(out[0]).toBe("line 1")
    expect(out.at(-2)).toBe("line 5000")
    expect(result.truncation).toEqual({ originalBytes: bytes(text), originalLines: 5000, spillPath: expect.any(String) })
    expect(readFileSync(result.truncation!.spillPath!, "utf8")).toBe(text)
    const marker = out.find((line) => line.startsWith("[..."))!
    expect(marker).toBe(
      `[... lines 999-4002 omitted (3004 lines, ${bytes(lines(4002)) - bytes(lines(998))} bytes) of 5000 lines. Full output: ${result.truncation!.spillPath} (read it with offset 999 to see the omitted lines).]`,
    )
    expect(out).toContain("line 998")
    expect(out).not.toContain("line 999")
    expect(out).toContain("line 4003")
    expect(countLines(Buffer.from(result.output))).toBeLessThanOrEqual(OUTPUT_LIMITS.maxLines)
  })

  test("too many bytes stays within the byte limit", async () => {
    const text = lines(1500, (n) => `${n} ${"x".repeat(200)}`)
    const result = await capOutput(text, tempDir())
    expect(bytes(result.output)).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    expect(result.output.startsWith("1 xxx")).toBe(true)
    expect(result.output.endsWith(`1500 ${"x".repeat(200)}\n`)).toBe(true)
    for (const line of result.output.split("\n")) expect(line === "" || line.startsWith("[...") || /^\d+ x{200}$/.test(line)).toBe(true)
  })

  test("never splits a multi-byte character, even inside one huge line", async () => {
    const text = "é😀€".repeat(40_000)
    const result = await capOutput(text, tempDir())
    expect(result.output).not.toContain("�")
    expect(bytes(result.output)).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    const [head, , marker, , tail] = result.output.split("\n")
    expect(text.startsWith(head!)).toBe(true)
    expect(text.endsWith(tail!)).toBe(true)
    expect(marker).toContain("bytes omitted from the middle; lines too long to show whole were cut. The full output is 1 lines")
    expect(result.truncation!.originalBytes).toBe(bytes(text))
  })

  test("multi-byte lines are cut on line boundaries", async () => {
    const text = lines(3000, (n) => `${n} 日本語のテキスト 😀`)
    const result = await capOutput(text, tempDir())
    expect(result.output).not.toContain("�")
    for (const line of result.output.split("\n").filter((line) => line !== "" && !line.startsWith("[...")))
      expect(line).toMatch(/^\d+ 日本語のテキスト 😀$/)
  })

  test("capping is deterministic and idempotent", async () => {
    const text = lines(10_000, (n) => `${n} ${"ü".repeat(n % 97)}`)
    const first = await capOutput(text, tempDir())
    const dir = tempDir()
    const second = await capOutput(text, dir)
    const third = await capOutput(text, dir)
    expect(second.output).toBe(third.output)
    expect(second.truncation).toEqual(third.truncation)
    // Identical apart from the spill directory, which is part of the marker.
    expect(first.output.replace(first.truncation!.spillPath!, "P")).toBe(second.output.replace(second.truncation!.spillPath!, "P"))
    // Capped output is within the limits, so capping it again changes nothing.
    expect(await capOutput(second.output, dir)).toEqual({ output: second.output, truncation: null })
  })

  test("a streaming source with only head and tail gives the same text as the whole output", () => {
    const text = Buffer.from(lines(20_000, (n) => `${n} ${"ab".repeat(n % 13)}`))
    const whole = renderCapped(
      { head: text, tail: text, tailAtLineStart: true, totalBytes: text.length, totalLines: countLines(text) },
      { path: "/spill", savedBytes: text.length },
    )
    const keep = 64 * 1024
    const streamed = renderCapped(
      {
        head: text.subarray(0, keep),
        tail: text.subarray(text.length - keep),
        tailAtLineStart: text[text.length - keep - 1] === 0x0a,
        totalBytes: text.length,
        totalLines: countLines(text),
      },
      { path: "/spill", savedBytes: text.length },
    )
    expect(streamed).toBe(whole)
  })

  test("says when the full output was not saved or only partly saved", () => {
    const text = Buffer.from(lines(3000))
    const source = { head: text, tail: text, tailAtLineStart: true, totalBytes: text.length, totalLines: 3000 }
    expect(renderCapped(source, { path: null, savedBytes: 0 })).toContain("The full output was not saved.]")
    expect(renderCapped(source, { path: "/s", savedBytes: 100 })).toContain("The first 100 bytes are saved in /s.]")
  })

  test("an unusable spill directory still produces capped text", async () => {
    const file = `${tempDir()}/not-a-dir`
    await Bun.write(file, "x")
    const result = await capOutput(lines(3000), `${file}/spill`)
    expect(result.truncation!.spillPath).toBeNull()
    expect(result.output).toContain("The full output was not saved.")
  })
})
