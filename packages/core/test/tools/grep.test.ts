import { afterEach, describe, expect, test } from "bun:test"
import { symlinkSync } from "node:fs"
import { createInterrupt } from "../../src/interrupt.ts"
import { context, outputOf, workspace, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

const rg = Bun.which("rg")
const engines = [
  { name: "pure", ripgrep: null },
  ...(rg === null ? [] : [{ name: "ripgrep", ripgrep: rg }]),
] as const

async function fixture(ws: ReturnType<typeof workspace>) {
  await ws.write("src/a.ts", "import x\nconst foo = 1\nbar()\nbaz()\nqux()\nzap()\nconst Foo = 2\n")
  await ws.write("src/b.js", "foo\r\nnothing\n")
  await ws.write("a-b.ts", "foo here\n")
  await ws.write("src/deep/c.ts", "no match\nlast foo")
  await ws.write(".hidden/h.ts", "foo hidden\n")
  await ws.write(".git/config", "foo git\n")
  await ws.write("node_modules/p/i.js", "foo module\n")
  await ws.write("bin.dat", new Uint8Array([0x66, 0x6f, 0x6f, 0, 1, 2]))
  await ws.write("unicode.txt", "naïve café\nend\n")
  symlinkSync(ws.path("src/a.ts"), ws.path("link.ts"))
}

const cases: { args: Record<string, unknown>; expected: string }[] = [
  {
    args: { pattern: "foo" },
    expected: ".hidden/h.ts:1:foo hidden\na-b.ts:1:foo here\nsrc/a.ts:2:const foo = 1\nsrc/b.js:1:foo\nsrc/deep/c.ts:2:last foo",
  },
  {
    args: { pattern: "foo", ignore_case: true, glob: "*.ts" },
    expected: ".hidden/h.ts:1:foo hidden\na-b.ts:1:foo here\nsrc/a.ts:2:const foo = 1\nsrc/a.ts:7:const Foo = 2\nsrc/deep/c.ts:2:last foo",
  },
  {
    args: { pattern: "foo", ignore_case: true, path: "src/a.ts", context: 1 },
    expected: "src/a.ts-1-import x\nsrc/a.ts:2:const foo = 1\nsrc/a.ts-3-bar()\n--\nsrc/a.ts-6-zap()\nsrc/a.ts:7:const Foo = 2",
  },
  {
    args: { pattern: "ba[rz]", path: "src", context: 2, glob: "*.ts" },
    expected: "src/a.ts-1-import x\nsrc/a.ts-2-const foo = 1\nsrc/a.ts:3:bar()\nsrc/a.ts:4:baz()\nsrc/a.ts-5-qux()\nsrc/a.ts-6-zap()",
  },
  { args: { pattern: "foo", path: "src", glob: "deep/*.ts" }, expected: "src/deep/c.ts:2:last foo" },
  { args: { pattern: "na.ve caf.$" }, expected: "unicode.txt:1:naïve café" },
  { args: { pattern: "^nothing$", path: "src" }, expected: "src/b.js:2:nothing" },
  { args: { pattern: "zzz" }, expected: 'No matches for "zzz" in the working directory.' },
]

describe("grep", () => {
  for (const engine of engines)
    describe(engine.name, () => {
      for (const { args, expected } of cases)
        test(`${JSON.stringify(args)}`, async () => {
          const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
          await fixture(ws)
          const outcome = await ws.call("grep", args)
          expect(outcome.settlement.outcome).toBe("success")
          expect(outputOf(outcome)).toBe(expected)
        })

      test("caps the number of matching lines and cuts long lines", async () => {
        const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
        await ws.write("many.txt", Array.from({ length: 300 }, (_, index) => `hit ${index + 1}`).join("\n"))
        await ws.write("wide.txt", `hit ${"w".repeat(1000)}\n`)
        const output = outputOf(await ws.call("grep", { pattern: "hit" }))
        const lines = output.split("\n")
        expect(lines[0]).toBe("many.txt:1:hit 1")
        expect(lines[249]).toBe("many.txt:250:hit 250")
        expect(lines.at(-1)).toBe("[Showing the first 250 of 301 matching lines. Narrow the pattern, path or glob.]")
        const wide = outputOf(await ws.call("grep", { pattern: "hit w" }))
        expect(wide).toBe(`wide.txt:1:hit ${"w".repeat(296)}... [line cut, 1004 characters long]`)
      })

      test("bounds the result by size, cut after a whole match and its context", async () => {
        const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
        // 250 matches, each with ten lines of context on either side, on lines of about 150 characters: before the
        // bound the result held every one of them, over 49 KB that the runtime then capped in the middle of a line.
        const filler = (line: number) => `line ${line} ${"x".repeat(140)}`
        const lines = Array.from({ length: 250 * 30 }, (_, index) => (index % 30 === 15 ? `needle ${index + 1}` : filler(index + 1)))
        await ws.write("big.txt", `${lines.join("\n")}\n`)
        const outcome = await ws.call("grep", { pattern: "needle", context: 10 })
        const output = outputOf(outcome)
        const [body, note] = output.split("\n\n[")
        expect(Buffer.byteLength(body!)).toBeLessThanOrEqual(20 * 1024)
        const groups = body!.split("\n--\n")
        // Every group is whole: ten lines before, the match, ten after.
        for (const [index, group] of groups.entries()) {
          const rows = group.split("\n")
          expect(rows).toHaveLength(21)
          expect(rows[10]).toBe(`big.txt:${index * 30 + 16}:needle ${index * 30 + 16}`)
          expect(rows[20]).toBe(`big.txt-${index * 30 + 26}-${filler(index * 30 + 26)}`)
        }
        const shown = groups.length
        expect(shown).toBeGreaterThan(1)
        expect(note).toBe(
          `Showing the first ${shown} of 250 matching lines; the other ${250 - shown} are left out to keep the result under 20 KB. Narrow the pattern, path or glob, or ask for fewer context lines.]`,
        )
        expect(outcome.settlement.truncation).toBeNull()
        expect(outcome.settlement.display).toMatchObject({ matches: 250, shown })
      })

      test("without context the size bound also cuts between matches", async () => {
        const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
        await ws.write("wide.txt", Array.from({ length: 200 }, (_, index) => `hit ${index + 1} ${"w".repeat(290)}`).join("\n"))
        const output = outputOf(await ws.call("grep", { pattern: "hit" }))
        const [body, note] = output.split("\n\n[")
        const rows = body!.split("\n")
        expect(Buffer.byteLength(body!)).toBeLessThanOrEqual(20 * 1024)
        expect(rows.every((row, index) => row.startsWith(`wide.txt:${index + 1}:hit ${index + 1} `))).toBe(true)
        expect(note).toBe(`Showing the first ${rows.length} of 200 matching lines; the other ${200 - rows.length} are left out to keep the result under 20 KB. Narrow the pattern, path or glob.]`)
      })

      test("reports an invalid regular expression and a missing path", async () => {
        const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
        await ws.write("a.txt", "x")
        const bad = await ws.call("grep", { pattern: "(unclosed" })
        expect(bad.settlement.outcome).toBe("error")
        expect(outputOf(bad)).toStartWith("Invalid regular expression")
        expect(outputOf(await ws.call("grep", { pattern: "x", path: "nope" }))).toBe("Path not found: nope")
      })

      test("an interrupted search says its results are incomplete", async () => {
        const ws = workspace({ grep: { ripgrep: engine.ripgrep } })
        await ws.write("a.txt", "x\n")
        const token = createInterrupt()
        const outcome = await ws.runtime.run(
          { name: "grep", argumentsText: '{"pattern":"x"}', context: context(ws.root, { signal: token.signal }) },
          { onStart: () => token.interrupt("user") },
        )
        expect(outcome.settlement.outcome).toBe("error")
        expect(outputOf(outcome)).toEndWith("[Search interrupted; results are incomplete.]")
      })
    })

  test.skipIf(rg === null)("both engines give identical output on a larger tree", async () => {
    const pure = workspace({ grep: { ripgrep: null } })
    const fast = workspace({ grep: { ripgrep: rg } })
    for (const ws of [pure, fast]) {
      for (let index = 0; index < 60; index += 1)
        await ws.write(`d${index % 7}/${index % 3 === 0 ? "x-" : ""}f${index}.txt`, Array.from({ length: 40 }, (_, line) => `row ${line} ${line % 5 === 0 ? "needle" : "hay"} ${index}`).join("\n"))
    }
    for (const args of [{ pattern: "needle" }, { pattern: "needle \\d+$", context: 2 }, { pattern: "NEEDLE", ignore_case: true, glob: "x-*" }]) {
      const expected = outputOf(await pure.call("grep", args))
      expect(outputOf(await fast.call("grep", args))).toBe(expected)
    }
  })
})
