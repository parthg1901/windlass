/**
 * The placeholder for a configured value in a command's output: in the
 * progress a running command reports, in the spill file that keeps a long
 * output in full, and in the result that is stored, also when the value
 * arrives split across two reads or sits where the output is capped.
 */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { redactPieces, unfinishedSecret } from "../../src/approval/redact.ts"
import type { ToolProgress } from "../../src/tool/tool.ts"
import { context, removeTempDirs, workspace } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

const SECRET = "EXAMPLE_VALUE_123"

/** Runs a command the way the step loop does when it has secrets to redact. */
async function run(command: string, options: { exact?: boolean } = {}) {
  const ws = workspace()
  const progress: ToolProgress[] = []
  const outcome = await ws.runtime.run({
    name: "shell",
    argumentsText: JSON.stringify({ command }),
    context: {
      ...context(ws.root, { progress }),
      redact: (text) => redactPieces(text, [SECRET]),
      ...(options.exact === false ? {} : { unfinishedSecret: (text: string) => unfinishedSecret(text, [SECRET]) }),
    },
  })
  const spillPath = outcome.settlement.truncation?.spillPath ?? null
  return { ws, progress, settlement: outcome.settlement, spill: spillPath === null ? null : readFileSync(spillPath, "utf8") }
}

/** No part of the value longer than its first few characters. */
function expectClean(text: string) {
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain("EXAMPLE_V")
  expect(text).not.toContain("VALUE_123")
}

describe("shell output redaction", () => {
  test("a value printed whole is replaced in the progress and the result", async () => {
    const { progress, settlement } = await run(`echo "key ${SECRET}"; sleep 0.3; echo done`)
    expect(progress.length).toBeGreaterThan(0)
    for (const update of progress) expectClean(update.text)
    expect(progress[0]!.text).toStartWith("key [REDACTED:env]")
    expect(settlement.output).toBe("key [REDACTED:env]\ndone\n")
  })

  for (const exact of [true, false])
    test(`a value split across two reads is replaced${exact ? "" : " (without the exact check)"}`, async () => {
      const { progress, settlement } = await run(`printf 'start ${SECRET.slice(0, 8)}'; sleep 0.4; printf '${SECRET.slice(8)} end\\n'; sleep 0.3; echo more`, { exact })
      for (const update of progress) expectClean(update.text)
      expect(progress.map((update) => update.text)).toContain("start [REDACTED:env] end")
      expect(settlement.output).toBe("start [REDACTED:env] end\nmore\n")
    })

  test("a long output: neither the spill file, nor the progress, nor the result holds the value", async () => {
    // Before, in the middle and at the end of 5000 lines, and once split across two reads.
    const command = [
      `echo "first ${SECRET}"`,
      `seq 1 2500`,
      `echo "middle ${SECRET}"`,
      `printf 'split ${SECRET.slice(0, 5)}'`,
      `sleep 0.3`,
      `printf '${SECRET.slice(5)} here\\n'`,
      `seq 2501 5000`,
      `echo "last ${SECRET}"`,
    ].join("; ")
    const { progress, settlement, spill } = await run(command)
    expect(settlement.truncation).not.toBeNull()
    expect(spill).not.toBeNull()
    expectClean(spill!)
    expect(spill!.split("[REDACTED:env]").length - 1).toBe(4)
    expect(spill).toContain("split [REDACTED:env] here\n")
    // The counts are those of the file that is kept, so its line numbers are right.
    expect(settlement.truncation!.originalBytes).toBe(Buffer.byteLength(spill!))
    expect(settlement.truncation!.originalLines).toBe(spill!.split("\n").length - 1)
    for (const update of progress) expectClean(update.text)
    expectClean(settlement.output)
    expect(settlement.output).toStartWith("first [REDACTED:env]\n")
    expect(settlement.output).toContain("last [REDACTED:env]\n")
  })

  test("a value where the output is capped, in one long line: no half of it, and no half placeholder", async () => {
    // The shell keeps the first 24832 bytes of a single overlong line; the value starts a few bytes before that.
    const command = `printf '%*s' 24827 '' | tr ' ' a; printf '${SECRET}'; printf '%*s' 40000 '' | tr ' ' b; echo`
    const { settlement, spill } = await run(command)
    expect(settlement.truncation).not.toBeNull()
    expectClean(settlement.output)
    expectClean(spill!)
    expect(spill).toContain(`${"a".repeat(10)}[REDACTED:env]${"b".repeat(10)}`)
    // The head ends before the placeholder instead of in the middle of it; the tail is the b's after it.
    const [head, rest] = settlement.output.split("\n\n[... ")
    expect(head).toMatch(/^a+(\[REDACTED:env\])?$/)
    expect(rest).toMatch(/\]\n\nb+\n$/)
  })

  test("a background command's log holds the placeholder too", async () => {
    const ws = workspace()
    let log: string | null = null
    let finished: Promise<unknown> = Promise.resolve()
    const outcome = await ws.runtime.run({
      name: "shell",
      argumentsText: JSON.stringify({ command: `printf 'bg ${SECRET.slice(0, 9)}'; sleep 0.2; echo '${SECRET.slice(9)}'`, background: true }),
      context: {
        ...context(ws.root),
        redact: (text) => redactPieces(text, [SECRET]),
        background: {
          command: (work) => {
            log = work.logPath
            finished = work.exited
            return { id: "bg_1" }
          },
        },
      },
    })
    expect(outcome.settlement.outcome).toBe("success")
    const exited = (await finished) as { output: string }
    expect(exited.output).toBe("bg [REDACTED:env]\n")
    expect(existsSync(log!)).toBe(true)
    expect(readFileSync(log!, "utf8")).toBe("bg [REDACTED:env]\n")
  })
})
