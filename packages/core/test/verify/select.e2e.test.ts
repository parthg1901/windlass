/** Check selection, the fingerprint, evidence and the acknowledgement tool. */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { noBlobStore } from "../../src/tool/tool.ts"
import { chmodSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { DecodeError, safeDecode } from "../../src/validate.ts"
import {
  acknowledgeTool,
  acknowledgement,
  buildEvidence,
  filesFor,
  fingerprintCheck,
  reusablePass,
  runChecks,
  selectChecks,
  verificationEvidence,
} from "../../src/verify/index.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { check, project, removeTempDirs } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

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
  test("changes with the command, the timeout, the patterns, a file's content, or a deletion; not with unrelated files or timestamps", async () => {
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
    expect(await fingerprintCheck({ ...typecheck, when: ["src/**", "notes.md"] }, changed, p.dir)).not.toBe(first)

    // The same bytes are the same input, whenever they were written.
    utimesSync(join(p.dir, "src/a.ts"), new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect(await fingerprintCheck(typecheck, changed, p.dir)).toBe(first)
    await p.write("src/a.ts", "export const a = 22\n")
    const edited = await fingerprintCheck(typecheck, changed, p.dir)
    expect(edited).not.toBe(first)

    rmSync(join(p.dir, "src/a.ts"))
    const deleted = await fingerprintCheck(typecheck, changed, p.dir)
    expect(deleted).not.toBe(edited)
    expect(deleted).not.toBe(first)
  })

  test("sees an edit that keeps the size and restores the modification time", async () => {
    const p = project()
    await p.write("a.ts", "const a = 1\n")
    const when = new Date(2021, 5, 1)
    utimesSync(join(p.dir, "a.ts"), when, when)
    const before = await fingerprintCheck(check("t", "tsc"), ["a.ts"], p.dir)
    await p.write("a.ts", "const a = 2\n")
    utimesSync(join(p.dir, "a.ts"), when, when)
    expect(await fingerprintCheck(check("t", "tsc"), ["a.ts"], p.dir)).not.toBe(before)
  })

  test("a file that cannot be read never fingerprints the same twice", async () => {
    const p = project()
    await p.write("a.ts", "const a = 1\n")
    chmodSync(join(p.dir, "a.ts"), 0o000)
    try {
      // Root reads anything; then the file is simply readable and the fingerprint is stable.
      if (process.getuid?.() === 0) return
      const typecheck = check("t", "tsc", { when: ["*.ts"] })
      expect(await fingerprintCheck(typecheck, ["a.ts"], p.dir)).not.toBe(await fingerprintCheck(typecheck, ["a.ts"], p.dir))
    } finally {
      chmodSync(join(p.dir, "a.ts"), 0o644)
    }
  })
})

describe("reusablePass", () => {
  const typecheck = check("typecheck", "tsc", { when: ["src/**"] })
  const result = (fingerprint: string, status: "passed" | "failed" = "passed", reusedFromSeq: number | null = null) => ({
    name: "typecheck",
    command: "tsc",
    status,
    exitCode: status === "passed" ? 0 : 1,
    signal: null,
    durationMs: 1,
    files: ["src/a.ts"],
    fingerprint,
    reusedFromSeq,
    outputPath: null,
    outputBytes: 0,
    outputLines: 0,
  })
  const standing = { check: typecheck, fingerprint: "f1", changedFilesKnown: true, sameBaseline: true, latest: { seq: 40, checks: [result("f1")] } }

  test("a pass on the same fingerprint stands, and names the run that produced it", () => {
    expect(reusablePass(standing)).toBe(40)
    // A result that was itself carried over points at the run that really ran the check.
    expect(reusablePass({ ...standing, latest: { seq: 60, checks: [result("f1", "passed", 40)] } })).toBe(40)
  })

  test("in doubt the check runs", () => {
    expect(reusablePass({ ...standing, fingerprint: "f2" })).toBeNull() // something it depends on changed
    expect(reusablePass({ ...standing, latest: { seq: 40, checks: [result("f1", "failed")] } })).toBeNull() // only a pass is carried
    expect(reusablePass({ ...standing, latest: { seq: 40, checks: [] } })).toBeNull() // it did not run last time
    expect(reusablePass({ ...standing, latest: null })).toBeNull()
    expect(reusablePass({ ...standing, changedFilesKnown: false })).toBeNull() // nobody knows which files changed
    expect(reusablePass({ ...standing, sameBaseline: false })).toBeNull() // the fingerprints cover different sets of files
    expect(reusablePass({ ...standing, check: check("typecheck", "tsc") })).toBeNull() // without `when` it depends on everything
    expect(reusablePass({ ...standing, fingerprint: "", latest: { seq: 40, checks: [result("")] } })).toBeNull()
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
        putBlob: noBlobStore,
      },
    )
    expect(result).toEqual({ status: "success", output: "Recorded as unresolved: test, lint.", truncation: null, attachments: [], display: null })
  })
})
