import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { compileSchema } from "../../src/tool/schema.ts"
import { specOf } from "../../src/tool/tool.ts"
import { outputOf, workspace, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

describe("standard tools", () => {
  test("are sorted by name, have supported schemas and do not depend on the machine", () => {
    const first = workspace()
    const second = workspace({ grep: { ripgrep: null }, shell: { shell: "/bin/sh" } })
    expect(first.tools.map((tool) => tool.name)).toEqual(["edit", "glob", "grep", "ls", "read", "shell", "write"])
    for (const tool of first.tools) compileSchema(tool.inputSchema)
    expect(first.tools.map(specOf)).toEqual(second.tools.map(specOf))
    expect(Object.fromEntries(first.tools.map((tool) => [tool.name, tool.effect]))).toEqual({
      edit: "write",
      glob: "read",
      grep: "read",
      ls: "read",
      read: "read",
      shell: "exec",
      write: "write",
    })
  })
})

describe("read", () => {
  test("shows numbered lines", async () => {
    const ws = workspace()
    await ws.write("a.txt", "one\ntwo\r\nthree")
    expect(await ws.call("read", { path: "a.txt" })).toMatchObject({
      kind: "completed",
      settlement: { outcome: "success", output: "1\tone\n2\ttwo\n3\tthree", truncation: null },
    })
  })

  test("pages with offset and limit and says how to continue", async () => {
    const ws = workspace()
    await ws.write("a.txt", Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n"))
    expect(outputOf(await ws.call("read", { path: "a.txt", offset: 9, limit: 2 }))).toBe(
      " 9\tl9\n10\tl10\n\n[Showing lines 9-10 of 12. Call read with offset 11 to continue.]",
    )
    expect(outputOf(await ws.call("read", { path: "a.txt", offset: 11 }))).toBe("11\tl11\n12\tl12")
    const past = await ws.call("read", { path: "a.txt", offset: 20 })
    expect(past.settlement).toMatchObject({ outcome: "error", output: "offset 20 is past the end of a.txt, which has 12 lines." })
  })

  test("stays within the output limit on its own, so the full file is never spilled", async () => {
    const ws = workspace()
    await ws.write("big.txt", `${"x".repeat(100)}\n`.repeat(5000))
    const outcome = await ws.call("read", { path: "big.txt" })
    expect(outcome.settlement.truncation).toBeNull()
    expect(outcome.settlement.output).toMatch(/\n\n\[Showing lines 1-\d+ of 5000\. Call read with offset \d+ to continue\.\]$/)
    expect(Buffer.byteLength(outcome.settlement.output)).toBeLessThanOrEqual(50 * 1024)
  })

  test("cuts long lines", async () => {
    const ws = workspace()
    await ws.write("long.txt", `${"a".repeat(5000)}\nshort\n`)
    const lines = outputOf(await ws.call("read", { path: "long.txt" })).split("\n")
    expect(lines[0]).toBe(`1\t${"a".repeat(2000)}... [line cut, 5000 characters long]`)
    expect(lines[1]).toBe("2\tshort")
  })

  test("errors: missing file (with similar names), directory, binary file, empty file", async () => {
    const ws = workspace()
    await ws.write("config.json", "{}")
    mkdirSync(ws.path("dir"))
    await ws.write("blob.bin", new Uint8Array([1, 2, 0, 3]))
    await ws.write("empty.txt", "")
    expect((await ws.call("read", { path: "config.yaml" })).settlement).toMatchObject({
      outcome: "error",
      output: "File not found: config.yaml. Similar names in the same directory: config.json",
    })
    expect(outputOf(await ws.call("read", { path: "nothing/here.txt" }))).toBe("File not found: nothing/here.txt")
    expect(outputOf(await ws.call("read", { path: "dir" }))).toBe("dir is a directory. Use ls to list it.")
    expect(outputOf(await ws.call("read", { path: "blob.bin" }))).toBe("Cannot read blob.bin: it looks like a binary file (4 bytes).")
    expect((await ws.call("read", { path: "empty.txt" })).settlement).toMatchObject({ outcome: "success", output: "(empty file)" })
  })

  test("absolute paths outside the working directory are shown absolute", async () => {
    const ws = workspace()
    const other = workspace()
    await other.write("x.txt", "hi")
    expect(outputOf(await ws.call("read", { path: other.path("missing") }))).toBe(`File not found: ${other.path("missing")}`)
  })
})

describe("write", () => {
  test("creates parent directories, then overwrites", async () => {
    const ws = workspace()
    expect(await ws.call("write", { path: "deep/er/a.ts", content: "a\nb\n" })).toMatchObject({
      kind: "completed",
      settlement: { outcome: "success", output: "Created deep/er/a.ts (2 lines, 4 bytes).", display: { created: true } },
    })
    expect(ws.read("deep/er/a.ts")).toBe("a\nb\n")
    expect(outputOf(await ws.call("write", { path: "deep/er/a.ts", content: "é" }))).toBe("Overwrote deep/er/a.ts (1 lines, 2 bytes).")
    expect(ws.read("deep/er/a.ts")).toBe("é")
  })

  test("refuses a directory and reports an unwritable path", async () => {
    const ws = workspace()
    mkdirSync(ws.path("d"))
    await ws.write("file", "x")
    expect(outputOf(await ws.call("write", { path: "d", content: "x" }))).toBe("d is a directory; give a file path.")
    expect(outputOf(await ws.call("write", { path: "file/child.txt", content: "x" }))).toStartWith("Cannot create the directory for file/child.txt: ")
  })
})

describe("edit", () => {
  test("replaces a unique string and reports a small diff only in display", async () => {
    const ws = workspace()
    await ws.write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n")
    const outcome = await ws.call("edit", { path: "a.ts", old_string: "five", new_string: "FIVE\n5" })
    expect(outcome.settlement).toMatchObject({ outcome: "success", output: "Edited a.ts: replaced 1 occurrence (line 5)." })
    expect(ws.read("a.ts")).toBe("one\ntwo\nthree\nfour\nFIVE\n5\nsix\nseven\neight\n")
    expect((outcome.settlement.display as { diff: string }).diff).toBe(
      ["--- a/a.ts", "+++ b/a.ts", "@@ -2,7 +2,8 @@", " two", " three", " four", "-five", "+FIVE", "+5", " six", " seven", " eight"].join("\n"),
    )
  })

  test("fails helpfully when the string is missing or occurs more than once", async () => {
    const ws = workspace()
    await ws.write("a.ts", "  foo()\nbar\n  foo()\n")
    expect((await ws.call("edit", { path: "a.ts", old_string: "baz", new_string: "x" })).settlement).toMatchObject({
      outcome: "error",
      output: "old_string was not found in a.ts. It must match the file exactly, including whitespace and indentation. Read the file to see its current content.",
    })
    expect(outputOf(await ws.call("edit", { path: "a.ts", old_string: "foo()\n    bar", new_string: "x" }))).toBe(
      "old_string was not found in a.ts. Text matching it apart from whitespace or indentation starts at line 1; read the file and copy the text exactly.",
    )
    expect(outputOf(await ws.call("edit", { path: "a.ts", old_string: "foo()", new_string: "x" }))).toBe(
      "old_string occurs 2 times in a.ts (lines 1, 3). Include more surrounding lines to make it unique, or set replace_all to true to replace every occurrence.",
    )
    expect(ws.read("a.ts")).toBe("  foo()\nbar\n  foo()\n")
  })

  test("replace_all replaces every occurrence, with one hunk per separated change", async () => {
    const ws = workspace()
    const lines = Array.from({ length: 20 }, (_, index) => (index === 1 || index === 17 ? "old" : `l${index + 1}`))
    await ws.write("a.ts", `${lines.join("\n")}\n`)
    const outcome = await ws.call("edit", { path: "a.ts", old_string: "old", new_string: "new", replace_all: true })
    expect(outputOf(outcome)).toBe("Edited a.ts: replaced 2 occurrences (lines 2, 18).")
    const diff = (outcome.settlement.display as { diff: string }).diff
    expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toEqual(["@@ -1,5 +1,5 @@", "@@ -15,6 +15,6 @@"])
  })

  test("deleting whole lines and joining lines give correct diffs", async () => {
    const ws = workspace()
    await ws.write("a.ts", "a\nb\nc\n")
    const removed = await ws.call("edit", { path: "a.ts", old_string: "b\n", new_string: "" })
    expect(ws.read("a.ts")).toBe("a\nc\n")
    expect((removed.settlement.display as { diff: string }).diff).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,2 @@\n a\n-b\n c")
    const joined = await ws.call("edit", { path: "a.ts", old_string: "a\n", new_string: "a" })
    expect(ws.read("a.ts")).toBe("ac\n")
    expect((joined.settlement.display as { diff: string }).diff).toBe("--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,1 @@\n-a\n-c\n+ac")
  })

  test("matches across CRLF line endings and keeps them", async () => {
    const ws = workspace()
    await ws.write("w.txt", "one\r\ntwo\r\nthree\r\n")
    expect(outputOf(await ws.call("edit", { path: "w.txt", old_string: "one\ntwo", new_string: "1\n2" }))).toBe(
      "Edited w.txt: replaced 1 occurrence (line 1).",
    )
    expect(ws.read("w.txt")).toBe("1\r\n2\r\nthree\r\n")
  })

  test("errors: missing file, directory, identical strings, empty old_string", async () => {
    const ws = workspace()
    mkdirSync(ws.path("d"))
    await ws.write("a.ts", "x")
    expect(outputOf(await ws.call("edit", { path: "nope.ts", old_string: "a", new_string: "b" }))).toBe(
      "File not found: nope.ts. Use write to create a file.",
    )
    expect(outputOf(await ws.call("edit", { path: "d", old_string: "a", new_string: "b" }))).toBe("d is a directory; give a file path.")
    expect(outputOf(await ws.call("edit", { path: "a.ts", old_string: "x", new_string: "x" }))).toBe(
      "old_string and new_string are identical; there is nothing to change.",
    )
    expect(await ws.call("edit", { path: "a.ts", old_string: "", new_string: "b" })).toMatchObject({
      kind: "refused",
      settlement: { output: "Invalid arguments for edit:\n- old_string: must not be empty\nFix them and call edit again." },
    })
  })
})

describe("ls", () => {
  test("lists one directory sorted, marking directories and links", async () => {
    const ws = workspace()
    await ws.write("b.txt", "")
    await ws.write("A.txt", "")
    await ws.write("sub/c.txt", "")
    mkdirSync(ws.path("node_modules"))
    symlinkSync(ws.path("b.txt"), ws.path("link"))
    expect(await ws.call("ls", {})).toMatchObject({
      settlement: { outcome: "success", output: "A.txt\nb.txt\nlink@\nnode_modules/\nsub/" },
    })
    expect(outputOf(await ws.call("ls", { path: "sub" }))).toBe("c.txt")
    expect(outputOf(await ws.call("ls", ""))).toBe("A.txt\nb.txt\nlink@\nnode_modules/\nsub/")
  })

  test("errors and empty directories", async () => {
    const ws = workspace()
    await ws.write("f", "")
    mkdirSync(ws.path("empty"))
    expect(outputOf(await ws.call("ls", { path: "missing" }))).toBe("Directory not found: missing")
    expect(outputOf(await ws.call("ls", { path: "f" }))).toBe("f is a file, not a directory. Use read to read it.")
    expect((await ws.call("ls", { path: "empty" })).settlement).toMatchObject({ outcome: "success", output: "empty is empty." })
  })

  test("caps long listings", async () => {
    const ws = workspace()
    await Promise.all(Array.from({ length: 1005 }, (_, index) => ws.write(`f${String(index).padStart(4, "0")}`, "")))
    const output = outputOf(await ws.call("ls", {}))
    expect(output.split("\n")[999]).toBe("f0999")
    expect(output).toEndWith("\n\n[Showing 1000 of 1005 entries. Use glob to narrow the listing.]")
  })
})

describe("glob", () => {
  test("finds files sorted by path, skipping .git and node_modules", async () => {
    const ws = workspace()
    for (const name of ["src/b.ts", "src/a.ts", "src/x/c.ts", "a-b.ts", ".hidden/d.ts", ".git/e.ts", "node_modules/p/f.ts", "src/readme.md"])
      await ws.write(name, "")
    expect(outputOf(await ws.call("glob", { pattern: "**/*.ts" }))).toBe(".hidden/d.ts\na-b.ts\nsrc/a.ts\nsrc/b.ts\nsrc/x/c.ts")
    expect(outputOf(await ws.call("glob", { pattern: "*.ts", path: "src" }))).toBe("src/a.ts\nsrc/b.ts")
    expect(outputOf(await ws.call("glob", { pattern: "./src/{a,b}.ts" }))).toBe("src/a.ts\nsrc/b.ts")
    expect(outputOf(await ws.call("glob", { pattern: "node_modules/**/*.ts" }))).toBe("node_modules/p/f.ts")
  })

  test("reports no matches, missing directories, absolute patterns, and caps results", async () => {
    const ws = workspace()
    await ws.write("a.txt", "")
    expect((await ws.call("glob", { pattern: "*.rs" })).settlement).toMatchObject({ outcome: "success", output: "No files match *.rs in the working directory." })
    expect(outputOf(await ws.call("glob", { pattern: "*", path: "nope" }))).toBe("Directory not found: nope")
    expect(outputOf(await ws.call("glob", { pattern: "/etc/*" }))).toBe("pattern must be relative; put the directory to search in `path`.")
    await Promise.all(Array.from({ length: 1003 }, (_, index) => ws.write(`many/${index}.txt`, "")))
    expect(outputOf(await ws.call("glob", { pattern: "many/*.txt" }))).toEndWith(
      "\n\n[Showing the first 1000 of 1003 files. Use a narrower pattern or path.]",
    )
  })
})
