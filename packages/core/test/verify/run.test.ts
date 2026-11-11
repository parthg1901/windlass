/** Real commands through the shell tool: pass, fail with long output, timeout, missing command, interrupt. */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createInterrupt } from "../../src/interrupt.ts"
import { OUTPUT_LIMITS, countLines } from "../../src/tool/cap.ts"
import { renderOutput, renderReport, runCheck, runChecks } from "../../src/verify/index.ts"
import { check, expectGone, isRunning, project, removeTempDirs } from "./helpers.ts"

afterEach(removeTempDirs)

const encoder = new TextEncoder()
const sizeOf = (text: string) => ({ bytes: encoder.encode(text).length, lines: countLines(encoder.encode(text)) })

/** Prints `count` numbered lines, then a final failure line, and exits 1. */
const LONG_FAILURE = (count: number) => `for i in $(seq 1 ${count}); do echo "test $i ok"; done; echo "error: expected 3, got 4 (at the end)"; exit 1`

describe("runCheck", () => {
  test("a passing check: status, exit code, output kept in a content-named file", async () => {
    const p = project()
    const result = await runCheck(check("hello", "echo hello; echo warn >&2"), p.options())
    expect(result).toMatchObject({ name: "hello", status: "passed", exitCode: 0, signal: null, interruptedBy: null, startError: null })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.output.path).toMatch(/check-hello-[0-9a-f]{32}\.log$/)
    expect(readFileSync(result.output.path!, "utf8")).toBe("hello\nwarn\n")
    expect(result.output).toMatchObject({ totalBytes: 11, totalLines: 2 })
    expect(readdirSync(p.spillDir)).toEqual([result.output.path!.split("/").pop()!])
  })

  test("runs in the project directory", async () => {
    const p = project()
    const result = await runCheck(check("pwd", "pwd; exit 2"), p.options())
    expect(result.status).toBe("failed")
    expect(renderOutput(result.output)).toBe(`${p.dir}\n`)
  })

  test("a failing check with long output: capped within the limits, tail kept, full output in the file", async () => {
    const p = project()
    const result = await runCheck(check("unit", LONG_FAILURE(5000)), p.options())
    expect(result).toMatchObject({ status: "failed", exitCode: 1 })
    const full = readFileSync(result.output.path!, "utf8")
    expect(full.split("\n")).toHaveLength(5002)
    expect(full).toStartWith("test 1 ok\n")
    expect(full).toEndWith("test 5000 ok\nerror: expected 3, got 4 (at the end)\n")
    expect(result.output).toMatchObject({ totalBytes: encoder.encode(full).length, totalLines: 5001 })

    const report = renderReport([result])
    const size = sizeOf(report)
    expect(size.bytes).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    expect(size.lines).toBeLessThanOrEqual(OUTPUT_LIMITS.maxLines)
    expect(report).toContain("error: expected 3, got 4 (at the end)\n[end of unit output]")
    expect(report).toContain(`Full output: ${result.output.path} (read it with offset `)
    const [head, tail] = report.split(/\n\[\.\.\. lines \d+-\d+ omitted[^\n]*\n/)
    const headLines = head!.split("\n").filter((line) => /^test \d+ ok$/.test(line)).length
    const tailLines = tail!.split("\n").filter((line) => /^test \d+ ok$/.test(line)).length
    expect(headLines).toBeGreaterThan(100)
    expect(tailLines).toBeGreaterThan(3 * headLines)
    // The kept lines are the real first and last lines of the output, in order.
    expect(report).toContain("test 1 ok\ntest 2 ok\n")
    expect(report).toContain(`test ${5000 - tailLines + 1} ok\n`)
  })

  test("output that fits the shell but not a shared report is capped by the report, from the same file", async () => {
    const p = project()
    const [first, second] = await runChecks([check("a", LONG_FAILURE(1500)), check("b", LONG_FAILURE(1500))], p.options())
    expect(first!.output.totalLines).toBe(1501)
    const report = renderReport([first!, second!])
    expect(sizeOf(report).bytes).toBeLessThanOrEqual(OUTPUT_LIMITS.maxBytes)
    expect(sizeOf(report).lines).toBeLessThanOrEqual(OUTPUT_LIMITS.maxLines)
    expect(report).toContain(`Full output: ${first!.output.path} `)
    expect(report.match(/error: expected 3, got 4 \(at the end\)\n\[end of [ab] output\]/g)).toHaveLength(2)
    // Identical output, one file.
    expect(first!.output.path!.replace("check-a-", "")).toBe(second!.output.path!.replace("check-b-", ""))
  })

  test("the same failure twice gives byte-identical model-facing text", async () => {
    const p = project()
    await p.write("value.txt", "4\n")
    const checks = [check("typecheck", "true"), check("unit", `${LONG_FAILURE(3000)}; cat value.txt`), check("short", "echo nope; exit 3")]
    const first = await runChecks(checks, p.options())
    const second = await runChecks(checks, p.options())
    expect(renderReport(second)).toBe(renderReport(first))
    expect(second.map((result) => result.output.path)).toEqual(first.map((result) => result.output.path))
    expect(renderReport(first)).not.toMatch(/\d+ ?ms\b/)
  })

  test("a check that times out is stopped with its process group", async () => {
    const p = project()
    const begin = performance.now()
    const result = await runCheck(check("slow", "echo pid=$$; sleep 30 & echo child=$!; wait", { timeoutSeconds: 1 }), p.options())
    expect(performance.now() - begin).toBeLessThan(3000)
    expect(result).toMatchObject({ status: "timed_out", exitCode: null })
    const text = renderReport([result])
    expect(text).toContain("timed out: slow (echo pid=$$; sleep 30 & echo child=$!; wait), stopped after 1 second. Output:\npid=")
    const pids = [...readFileSync(result.output.path!, "utf8").matchAll(/=(\d+)/g)].map((match) => Number(match[1]))
    expect(pids).toHaveLength(2)
    expect(await expectGone(pids, isRunning)).toEqual([])
  })

  test("a command that does not exist could not start", async () => {
    const p = project()
    const result = await runCheck(check("lint", "definitely-not-a-command-lh"), p.options())
    expect(result).toMatchObject({ status: "could_not_start", exitCode: 127, startError: null })
    expect(renderOutput(result.output)).toContain("definitely-not-a-command-lh")
    expect(renderReport([result])).toContain("could not start: lint (definitely-not-a-command-lh), exit code 127. Output:\n")
  })

  test("a shell that cannot be spawned could not start, with the reason", async () => {
    const p = project()
    const result = await runCheck(check("test", "true"), p.options({ cwd: join(p.dir, "missing") }))
    expect(result).toMatchObject({ status: "could_not_start", exitCode: null, output: { path: null, totalBytes: 0 } })
    expect(result.startError).not.toBeNull()
    expect(renderReport([result])).toContain(`could not start: test (true): ${result.startError}`)
  })

  test("an interrupted check stops its processes, and the remaining checks do not run", async () => {
    const p = project()
    const token = createInterrupt()
    const seen: string[] = []
    const running = runChecks(
      [check("watch", "echo pid=$$; sleep 30 & echo child=$!; sleep 0.3; touch started; wait"), check("after", "touch ran-after")],
      p.options({ signal: token.signal, progress: (name, text) => seen.push(`${name}:${text}`) }),
    )
    while (!existsSync(join(p.dir, "started"))) await Bun.sleep(10)
    token.interrupt("user")
    const [watch, after] = await running
    expect(watch).toMatchObject({ status: "interrupted", interruptedBy: "user" })
    expect(after).toMatchObject({ status: "interrupted", interruptedBy: "user", output: { path: null } })
    expect(existsSync(join(p.dir, "ran-after"))).toBe(false)
    expect(seen[0]).toStartWith("watch:pid=")
    const pids = [...readFileSync(watch!.output.path!, "utf8").matchAll(/=(\d+)/g)].map((match) => Number(match[1]))
    expect(await expectGone(pids, isRunning)).toEqual([])
    expect(renderReport([watch!, after!])).toBe(
      [
        "Checks run by the harness after your changes: 2 interrupted.",
        "interrupted: watch (echo pid=$$; sleep 30 & echo child=$!; sleep 0.3; touch started; wait), stopped by the user",
        "interrupted: after (touch ran-after), stopped by the user",
        "",
      ].join("\n"),
    )
  })

  test("a signal kills the check: failed, with the signal named", async () => {
    const p = project()
    const result = await runCheck(check("crash", "echo dying; kill -9 $$"), p.options())
    expect(result).toMatchObject({ status: "failed", exitCode: null, signal: "SIGKILL" })
    expect(renderReport([result])).toContain("failed: crash (echo dying; kill -9 $$), killed by signal SIGKILL. Output:\ndying\n[end of crash output]")
  })
})
