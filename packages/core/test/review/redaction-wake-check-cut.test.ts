/**
 * A wake-up check's output is cut to its beginning and end before it is redacted, so a credential that straddles
 * the cut is shown in part.
 *
 * Promise. docs/safety.md, "Secrets in tool output": "Where long output is shortened, the cut never splits a
 * placeholder." packages/core/src/wake/check.ts, `CheckOutcome`: "`output` is capped and redacted". The firing's
 * text goes into the session's log and to the model provider (docs/wake-ups.md, "What happens when one fires").
 *
 * What happens. `createCheckRunner` calls `shown(result.output.source, shownBytes)`, which cuts the head at
 * `shownBytes / 2` bytes and the tail likewise, and only then `redact(...)`. A value that begins before the cut
 * and ends after it is no longer whole in either half; the half that is shown no longer matches, and it is kept
 * as printed. With the default 4096 bytes, any value that starts within its own length of byte 2048 is shown up
 * to the cut (here 20 of its 30 characters). The same holds for the token formats (a GitHub token cut after 30
 * of its 40 characters no longer has the 36 the pattern needs).
 *
 * Code path. packages/core/src/wake/check.ts `createCheckRunner`:
 * `const output = redact(shown(result.output.source, shownBytes), options.secrets?.() ?? []).text`, and `shown`
 * below it.
 *
 * Smallest fix. Redact the head and the tail before cutting them (decode a little more than `half` on each side,
 * redact, then cut at a piece boundary as `tool/cap.ts` does for tool output), or redact the whole spilled output
 * while streaming it (it is read once anyway for the fingerprint) and cut the redacted text.
 *
 * What else the fix affects. Only the text a firing shows; the fingerprint is computed over the raw output and
 * need not change.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCheckRunner } from "../../src/wake/check.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const VALUE = "EXAMPLE_VALUE_1234567890ABCDEF"

test.failing("a credential value that straddles the cut of a long check output is not shown, not even in part", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "review-wake-cut-"))
  const spillDir = mkdtempSync(join(tmpdir(), "review-wake-spill-"))
  directories.push(cwd, spillDir)
  // Short lines; the value starts 20 bytes before byte 2048, where the default 4096-byte view cuts the head.
  const before = "x".repeat(99) + "\n"
  const head = before.repeat(20) + "y".repeat(2048 - 20 - before.length * 20)
  writeFileSync(join(cwd, "out.txt"), `${head}${VALUE}\n${"z".repeat(99)}\n`.padEnd(12_000, "w\n"))
  const run = createCheckRunner({ spillDir, secrets: () => [VALUE] })
  const outcome = await run({ name: "wk_review", command: "cat out.txt", cwd, timeoutMs: 10_000, run: { kind: "unsandboxed" }, sessionId: "ses_1", signal: new AbortController().signal })
  if (outcome.kind !== "exited") throw new Error(`the check did not run: ${outcome.kind}`)
  expect(outcome.output).toContain("bytes left out")
  // Today the head ends with "EXAMPLE_VALUE_123456": the first 20 characters of the value.
  expect(outcome.output).not.toContain(VALUE.slice(0, 20))
})
