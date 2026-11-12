/**
 * A wake-up check's long output is redacted before it is cut to its beginning and end, and the cut never splits a
 * placeholder (docs/safety.md, "Secrets in tool output"), so a credential that lies across a cut is not shown, not
 * even in part. The firing's text goes into the session's log and to the model provider.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { redact } from "../../src/approval/redact.ts"
import { createCheckRunner } from "../../src/wake/check.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const VALUE = "EXAMPLE_VALUE_1234567890ABCDEF"

async function outputOf(content: string, options: { readonly secrets?: readonly string[]; readonly shownBytes?: number } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "review-wake-cut-"))
  const spillDir = mkdtempSync(join(tmpdir(), "review-wake-spill-"))
  directories.push(cwd, spillDir)
  writeFileSync(join(cwd, "out.txt"), content)
  const run = createCheckRunner({ spillDir, secrets: () => options.secrets ?? [VALUE], ...(options.shownBytes === undefined ? {} : { shownBytes: options.shownBytes }) })
  const outcome = await run({ name: "wk_review", command: "cat out.txt", cwd, timeoutMs: 10_000, run: { kind: "unsandboxed" }, sessionId: "ses_1", signal: new AbortController().signal })
  if (outcome.kind !== "exited") throw new Error(`the check did not run: ${outcome.kind}`)
  return outcome.output
}

/**
 * The output as the runner keeps it: the value is replaced as the output arrives, before anything is counted or
 * cut, so "bytes left out" counts the kept text, not what the command printed.
 */
const kept = (content: string) => redact(content, [VALUE]).text

/** The number in the line that says how much is left out. */
function leftOut(output: string): number {
  const match = /\[… (\d+) bytes left out …\]/.exec(output)
  if (match === null) throw new Error("nothing was left out")
  return Number(match[1])
}

test("a credential value that straddles the cut of a long check output is not shown, not even in part", async () => {
  // Short lines; the value starts 20 bytes before byte 2048, where the default 4096-byte view cuts the head.
  const before = "x".repeat(99) + "\n"
  const head = before.repeat(20) + "y".repeat(2048 - 20 - before.length * 20)
  const output = await outputOf(`${head}${VALUE}\n${"z".repeat(99)}\n`.padEnd(12_000, "w\n"))
  expect(output).toContain("bytes left out")
  expect(output).not.toContain(VALUE.slice(0, 20))
})

test("in one long line the head is cut before the placeholder, not through it, and the count left out is of the kept output", async () => {
  const content = `${"y".repeat(2040)}${VALUE}${"w".repeat(10_000)}`
  const output = await outputOf(content)
  expect(output).not.toContain(VALUE.slice(0, 8))
  expect(output).not.toContain("[REDACTED:")
  expect(output.startsWith("y".repeat(2040) + "\n[…")).toBe(true)
  // The head shows 2040 bytes, the tail 2048 of the 10,000 after the value: what is between is left out.
  expect(leftOut(output)).toBe(kept(content).length - 2040 - 2048)
})

test("a placeholder that fits before the cut is shown whole", async () => {
  const output = await outputOf(`${"y".repeat(2000)}${VALUE}${"w".repeat(10_000)}`)
  expect(output.startsWith(`${"y".repeat(2000)}[REDACTED:env]${"w".repeat(2048 - 2000 - 14)}\n[…`)).toBe(true)
})

test("a value across the cut of the tail is not shown in part either", async () => {
  // As printed, the value begins 10 bytes before the last 2048. Redacted, it is shorter, so the tail shows it whole.
  const after = "w".repeat(2048 - (VALUE.length - 10))
  const content = `${"y".repeat(10_000)}${VALUE}${after}`
  const output = await outputOf(content)
  expect(output).not.toContain(VALUE.slice(-20))
  expect(output.endsWith(`…]\n${"y".repeat(2048 - 14 - after.length)}[REDACTED:env]${after}`)).toBe(true)
  expect(leftOut(output)).toBe(content.length - 2048 - (2048 - 14 - after.length) - VALUE.length - after.length)
})

test("a token format across the cut is redacted too", async () => {
  // A GitHub-style token (synthetic) whose first 30 of 40 characters fall before the head's cut.
  const token = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`
  const output = await outputOf(`${"y".repeat(2048 - 31)} ${token} ${"w".repeat(10_000)}`, { secrets: [] })
  expect(output).not.toContain(token.slice(0, 12))
})

test("a value across the cut of output that the runner kept whole (not much over the limit) is not shown in part", async () => {
  const content = `${"y".repeat(500 - 6)}${VALUE}${"w".repeat(600)}`
  const output = await outputOf(content, { shownBytes: 1000 })
  expect(output).not.toContain(VALUE.slice(0, 6))
  expect(leftOut(output)).toBe(kept(content).length - (500 - 6) - 500)
})

test("a tail cut that would fall inside a placeholder moves past it", async () => {
  // Redacted, the last 2048 bytes start 7 bytes into the placeholder: the tail starts after it.
  const output = await outputOf(`${"y".repeat(10_000)}${VALUE}${"w".repeat(2048 - 7)}`)
  expect(output.endsWith(`…]\n${"w".repeat(2048 - 7)}`)).toBe(true)
  expect(output).not.toContain("env]")
})
