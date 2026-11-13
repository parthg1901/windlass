/**
 * A background command's output a line at a time (`BackgroundCommand.lines`),
 * which is what a watch on its output reads: the lines still in memory, then
 * each further line as it completes, redacted as the log is.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { redactPieces, unfinishedSecret } from "../../src/approval/redact.ts"
import type { BackgroundCommand } from "../../src/tool/tool.ts"
import { context, removeTempDirs, workspace } from "./helpers.ts"

afterEach(removeTempDirs)

const SECRET = "EXAMPLE_VALUE_123"

/** Starts a real command in the background and hands back what the session would be given. */
async function background(command: string, options: { redact?: boolean } = {}): Promise<BackgroundCommand> {
  const ws = workspace()
  let work: BackgroundCommand | null = null
  const outcome = await ws.runtime.run({
    name: "shell",
    argumentsText: JSON.stringify({ command, background: true }),
    context: {
      ...context(ws.root),
      ...(options.redact === true ? { redact: (text: string) => redactPieces(text, [SECRET]), unfinishedSecret: (text: string) => unfinishedSecret(text, [SECRET]) } : {}),
      background: {
        command: (started) => {
          work = started
          return { id: "bg_1" }
        },
      },
    },
  })
  expect(outcome.settlement.outcome).toBe("success")
  return work!
}

const until = async (check: () => boolean) => {
  for (let waited = 0; !check(); waited += 5) {
    if (waited > 10_000) throw new Error("timed out waiting")
    await Bun.sleep(5)
  }
}

describe("a background command's output, a line at a time", () => {
  test("a listener gets the lines already printed, then each further line, then a last line without a line break", async () => {
    const work = await background("echo one; echo two; printf 'thr'; sleep 0.3; echo ee; echo four; printf 'last'")
    await until(() => work.output().includes("thr"))
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    // What was printed in full so far, at once; the line being printed is not a line yet.
    expect(lines).toEqual(["one", "two"])
    await work.exited
    expect(lines).toEqual(["one", "two", "three", "four", "last"])
  })

  test("each listener starts with what is in memory, and one that stops listening is not called again", async () => {
    const work = await background("echo one; sleep 0.3; echo two; sleep 0.3; echo three")
    await until(() => work.output().includes("one"))
    const first: string[] = []
    const second: string[] = []
    const stop = work.lines!((line) => first.push(line))
    await until(() => first.includes("two"))
    stop()
    work.lines!((line) => second.push(line))
    expect(second).toEqual(["one", "two"])
    await work.exited
    expect(first).toEqual(["one", "two"])
    expect(second).toEqual(["one", "two", "three"])
  })

  test("a command that has ended still shows the lines in memory, the last one included", async () => {
    const work = await background("echo one; printf 'no line break'")
    await work.exited
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    expect(lines).toEqual(["one", "no line break"])
  })

  test("carriage returns at a line's end are dropped, and stderr is output too", async () => {
    const work = await background("printf 'ready\\r\\n'; echo oops >&2")
    await work.exited
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    expect(lines.sort()).toEqual(["oops", "ready"])
  })

  test("lines are what the log holds: a configured value is its placeholder", async () => {
    const work = await background(`echo 'token ${SECRET.slice(0, 9)}'"${SECRET.slice(9)}"; sleep 0.2; echo 'again ${SECRET}'`, { redact: true })
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    await work.exited
    expect(lines).toEqual(["token [REDACTED:env]", "again [REDACTED:env]"])
  })

  test("a very long line is cut, and the lines after it are whole", async () => {
    const work = await background("head -c 40000 /dev/zero | tr '\\0' 'a'; echo; echo after")
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    await work.exited
    expect(lines.map((line) => line.length)).toEqual([16 * 1024, 5])
    expect(lines[1]).toBe("after")
  })

  test("when more was printed than is kept in memory, the first line given is a whole one", async () => {
    // About 200 KiB in lines of 100 bytes: the memory holds the last 64 KiB.
    const work = await background("i=0; while [ $i -lt 2000 ]; do printf 'line %04d %s\\n' $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done")
    await work.exited
    const lines: string[] = []
    work.lines!((line) => lines.push(line))
    expect(lines.length).toBeGreaterThan(500)
    expect(lines.length).toBeLessThan(2000)
    expect(lines.every((line) => /^line \d{4} x+$/.test(line))).toBe(true)
    expect(lines.at(-1)).toStartWith("line 1999 ")
  })
})
