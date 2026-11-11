/** Check selection, the fingerprint, evidence and the acknowledgement tool. */
import { afterEach, describe, expect, test } from "bun:test"
import { rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { DecodeError, safeDecode } from "../../src/validate.ts"
import {
  acknowledgeTool,
  acknowledgement,
  buildEvidence,
  filesFor,
  fingerprintCheck,
  runChecks,
  selectChecks,
  verificationEvidence,
} from "../../src/verify/index.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { check, project, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

describe("selectChecks", () => {
  const checks = [
    check("typecheck", "tsc", { when: ["**/*.ts", "tsconfig.json"] }),
    check("docs", "lint-docs", { when: ["docs/**"] }),
    check("everything", "make test"),
  ]
  const names = (files: string[]) => selectChecks(checks, files).map((selected) => selected.name)

  test("no changes, no checks", () => expect(names([])).toEqual([]))
  test("a check without `when` runs on any change", () => expect(names(["README.md"])).toEqual(["everything"]))
  test("patterns match paths relative to the project", () => {
    expect(names(["src/deep/a.ts"])).toEqual(["typecheck", "everything"])
    expect(names(["tsconfig.json"])).toEqual(["typecheck", "everything"])
    expect(names(["./docs/guide.md"])).toEqual(["docs", "everything"])
    expect(names(["packages/tsconfig.json"])).toEqual(["everything"])
  })
  test("the configuration's order, whatever the order of the changes", () => {
    expect(names(["docs/a.md", "src/a.ts"])).toEqual(names(["src/a.ts", "docs/a.md"]))
    expect(names(["docs/a.md", "src/a.ts"])).toEqual(["typecheck", "docs", "everything"])
  })
  test("filesFor: the matching files, sorted and unique", () => {
    expect(filesFor(checks[0]!, ["src/b.ts", "docs/x.md", "src/a.ts", "src/b.ts"])).toEqual(["src/a.ts", "src/b.ts"])
    expect(filesFor(checks[2]!, ["b", "a", "b"])).toEqual(["a", "b"])
  })
})

describe("fingerprintCheck", () => {
  test("changes with the command, the timeout, a file's size or mtime, or a deletion; not with unrelated files", async () => {
    const p = project()
    await p.write("src/a.ts", "export const a = 1\n")
    await p.write("notes.md", "x")
    const typecheck = check("typecheck", "tsc", { when: ["src/**"] })
    const changed = ["src/a.ts", "notes.md"]
    const first = await fingerprintCheck(typecheck, changed, p.dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(await fingerprintCheck(typecheck, [...changed].reverse(), p.dir)).toBe(first)

    await p.write("notes.md", "a longer note")
    expect(await fingerprintCheck(typecheck, changed, p.dir)).toBe(first)

    expect(await fingerprintCheck({ ...typecheck, command: "tsc --strict" }, changed, p.dir)).not.toBe(first)
    expect(await fingerprintCheck({ ...typecheck, timeoutSeconds: 31 }, changed, p.dir)).not.toBe(first)

    utimesSync(join(p.dir, "src/a.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    const touched = await fingerprintCheck(typecheck, changed, p.dir)
    expect(touched).not.toBe(first)
    await p.write("src/a.ts", "export const a = 22\n")
    utimesSync(join(p.dir, "src/a.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect(await fingerprintCheck(typecheck, changed, p.dir)).not.toBe(touched)

    rmSync(join(p.dir, "src/a.ts"))
    expect(await fingerprintCheck(typecheck, changed, p.dir)).not.toBe(touched)
  })

  test("what it misses: same size and restored mtime", async () => {
    const p = project()
    await p.write("a.ts", "const a = 1\n")
    const when = new Date(2021, 5, 1)
    utimesSync(join(p.dir, "a.ts"), when, when)
    const before = await fingerprintCheck(check("t", "tsc"), ["a.ts"], p.dir)
    await p.write("a.ts", "const a = 2\n")
    utimesSync(join(p.dir, "a.ts"), when, when)
    expect(await fingerprintCheck(check("t", "tsc"), ["a.ts"], p.dir)).toBe(before)
  })
})

describe("evidence", () => {
  test("a strict record of what ran, on which files, with where the output is", async () => {
    const p = project()
    await p.write("src/a.ts", "x")
    const checks = [check("typecheck", "true", { when: ["src/**"] }), check("test", "echo boom; exit 1")]
    const changedFiles = ["src/a.ts", "README.md"]
    const results = await runChecks(checks, p.options())
    const fingerprints = Object.fromEntries(await Promise.all(checks.map(async (item) => [item.name, await fingerprintCheck(item, changedFiles, p.dir)])))
    const evidence = buildEvidence({ run: 1, afterSeq: 42, changedFiles, checks, results, fingerprints })
    expect(evidence).toMatchObject({
      run: 1,
      afterSeq: 42,
      changedFiles: ["README.md", "src/a.ts"],
      checks: [
        { name: "typecheck", status: "passed", exitCode: 0, files: ["src/a.ts"], fingerprint: fingerprints.typecheck, outputBytes: 0 },
        { name: "test", status: "failed", exitCode: 1, files: ["README.md", "src/a.ts"], outputBytes: 5, outputLines: 1 },
      ],
    })
    expect(await Bun.file(evidence.checks[1]!.outputPath!).text()).toBe("boom\n")
    // It survives a JSON round trip through its own validator, as a stored event would.
    expect(verificationEvidence(JSON.parse(JSON.stringify(evidence)), "")).toEqual(evidence)
  })

  test("a missing fingerprint is a bug, not an empty value", async () => {
    const p = project()
    const checks = [check("test", "true")]
    const results = await runChecks(checks, p.options())
    expect(() => buildEvidence({ run: 1, afterSeq: 0, changedFiles: ["a"], checks, results, fingerprints: {} })).toThrow(DecodeError)
  })
})

describe("acknowledgement", () => {
  test("the tool validates like any tool input and records the names", async () => {
    expect(safeDecode(acknowledgement, { checks: ["test"], reason: "needs a database" }).ok).toBe(true)
    expect(safeDecode(acknowledgement, { checks: ["test"] }).ok).toBe(false)
    expect(safeDecode(acknowledgement, { checks: ["test"], reason: "" }).ok).toBe(false)
    expect(safeDecode(acknowledgement, { checks: [""], reason: "r" }).ok).toBe(false)
    const tool = acknowledgeTool()
    expect(tool).toMatchObject({ name: "report_check_failure", effect: "read" })
    const result = await tool.execute(
      { checks: ["test", "lint"], reason: "r" },
      {
        sessionId: "ses" as SessionId,
        messageId: "msg" as MessageId,
        callId: "call" as CallId,
        cwd: "/",
        signal: createInterrupt().signal,
        progress: () => {},
      },
    )
    expect(result).toEqual({ status: "success", output: "Recorded as unresolved: test, lint.", truncation: null, attachments: [], display: null })
  })
})
