/**
 * Keeps the suite from waiting on time. A test that sleeps for a while and then
 * looks ("give it 300 ms") passes on a quiet machine and fails on a loaded CI
 * runner; a test waits for the state it means with `waitFor` from
 * `@windlass/core/testing` instead. Every timed wait left in a test file is
 * counted here, and a file may have only the ones listed below, each with the
 * reason time is the point there. Adding a timed wait fails this test: replace
 * it with `waitFor`, or, if the time itself is what is tested, add it to the
 * list with the reason.
 *
 * It also keeps the two kinds of test apart (CONTRIBUTING.md, "Tests and fixtures"): a test
 * file that starts a process itself is an end-to-end test, named
 * `*.e2e.test.ts`, and every end-to-end file sets a time limit for its tests
 * sized for a slow runner.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..", "..")

/**
 * The timed waits each file may have, and why time is the point there. Kinds of reason:
 * - a stimulus: a fake server, tool or process that is slow on purpose, or acts after a delay. A slower machine
 *   makes it slower still, which the test allows.
 * - a quiet period: the test checks that nothing more happens. A slower machine can only make it miss a fault,
 *   never fail a correct program.
 * - time passing is what is tested: a window, a backoff, a clock that must move.
 * - a holder: a child process that sleeps to hold something (a lock, a session) until it is killed.
 * - a deadline or watchdog: a timer that ends a test that hangs.
 */
const ALLOWED: Record<string, { readonly count: number; readonly why: string }> = {
  // Stimuli
  "packages/acp/test/client.e2e.test.ts": { count: 1, why: "an approver that holds each question a moment, to show questions are asked one at a time" },
  "packages/cli/test/paths.e2e.test.ts": { count: 2, why: "keys typed a moment after the output they answer, as a person types" },
  "packages/cli/test/sending.e2e.test.ts": { count: 1, why: "a session whose look at the hooks is slow, as it can be under load" },
  "packages/core/test/auth/refresh.e2e.test.ts": { count: 1, why: "the token endpoint answers slowly so that callers overlap" },
  "packages/core/test/codemode/runner.e2e.test.ts": { count: 3, why: "a host whose calls take a set time; the stop's result arrives a moment after the stop" },
  "packages/core/test/engine/schedule.test.ts": { count: 4, why: "tools that take a set time, to show calls run side by side; the bounds sit halfway between overlapping and serial" },
  "packages/core/test/hooks/run.e2e.test.ts": { count: 1, why: "an interrupt of a hook that sleeps for 30 s" },
  "packages/core/test/lsp/fixtures/server.ts": { count: 1, why: "a language server that answers late, on request" },
  "packages/core/test/mcp/fixtures/behaviour.ts": { count: 1, why: "the slow tool reports progress over the time it is asked to take" },
  "packages/core/test/mcp/fixtures/stdio-server.ts": { count: 1, why: "a server that is slow to start, on request" },
  "packages/core/test/provider/openai-responses.test.ts": { count: 5, why: "fake servers that stall, trickle or drop a connection on purpose" },
  "packages/core/test/store/fixtures/read-holder.ts": { count: 1, why: "another process holds a read on a session file for half a second while the store opens it" },
  "packages/core/test/store/directory-process.e2e.test.ts": { count: 2, why: "listings taken while other processes write, and processes killed at a moment that varies by round" },
  "packages/core/test/store/process.e2e.test.ts": { count: 1, why: "a writer killed at a random moment" },
  "packages/core/test/telemetry/exporter.test.ts": { count: 1, why: "a collector that answers after 5 s, against a 100 ms attempt timeout" },
  "packages/core/test/testing/fake-provider.test.ts": { count: 1, why: "an interrupt during a minute-long scripted delay, which the stream reaches before any timer runs" },
  "packages/core/test/tool/runtime.test.ts": { count: 1, why: "a tool that takes the time it is given, until it is stopped" },
  "packages/core/test/tool/tool.test.ts": { count: 1, why: "a tool that ticks until it is stopped" },
  "packages/core/test/tools/shell.e2e.test.ts": { count: 1, why: "a shutdown of a command that sleeps for 30 s" },
  "test/release/login.test.ts": { count: 1, why: "Ctrl-C typed a moment after the prompt, as a person types" },

  // Quiet periods: nothing more may happen
  "packages/acp/test/cancel.e2e.test.ts": { count: 1, why: "nothing about the session arrives after the cancelled response" },
  "packages/acp/test/hooks-lsp.e2e.test.ts": { count: 1, why: "the same hook state is not announced twice" },
  "packages/core/test/engine/call-stop.test.ts": { count: 1, why: "a tool that comes back after its call was settled writes nothing more" },
  "packages/core/test/engine/mcp.e2e.test.ts": { count: 1, why: "a listener that was removed hears nothing more" },
  "packages/core/test/engine/spawn.test.ts": {
    count: 3,
    why: "the parent's execution does not end while its child works; and a turn of the event loop for a killed process's pending work to fail before the restart",
  },
  "packages/core/test/engine/wake-servers.e2e.test.ts": { count: 2, why: "a wake-up fires once across two servers, and not again" },
  "packages/core/test/engine/wake.test.ts": { count: 3, why: "a cancelled or queued wake-up starts nothing, and none fires after shutdown" },
  "packages/core/test/lsp/registry.e2e.test.ts": {
    count: 4,
    why: "a server that is off or not approved is not started; an interrupt during a 5 s wait; and a wait out of the 100 ms restart backoff",
  },
  "packages/core/test/sandbox/linux.e2e.test.ts": { count: 1, why: "SIGTERM to the sandbox kills nothing at once: the commands get their grace period" },
  "packages/core/test/wake/check.e2e.test.ts": { count: 2, why: "a background child does not survive its check's timeout; and an interrupt of a check that sleeps for 30 s" },
  "packages/core/test/wake/scheduler.test.ts": { count: 1, why: "no further sleep is asked for while the clock stands still" },

  // Time passing is what is tested
  "packages/cli/test/signals.e2e.test.ts": { count: 1, why: "a second Ctrl-C more than two seconds after the first is a new first press" },
  "packages/core/test/engine/listing-time.e2e.test.ts": { count: 1, why: "the listing cache trusts a row only two seconds after its file last changed" },
  "packages/core/test/store/directory.test.ts": { count: 1, why: "a file changed a moment ago: the clock must move past the last check" },
  "packages/tui/test/terminal.e2e.test.ts": { count: 2, why: "the approval dock arms itself after a set time; and a preload that throws from a timer once the interface is up" },
  "packages/tui/test/helpers.ts": { count: 1, why: "a lone Esc takes effect after the input parser's own shorter timer" },

  // Holders: sleep until killed
  "packages/cli/test/acp-subprocess.e2e.test.ts": { count: 1, why: "an engine server that never becomes ready" },
  "packages/core/test/memory/store.e2e.test.ts": { count: 1, why: "a writer that holds the lock until it is killed" },
  "packages/core/test/store/fixtures/directory-child.ts": { count: 3, why: "a child that holds a session open until it is killed, and one that appends slowly so that listings interleave" },
  "packages/core/test/store/fixtures/writer.ts": { count: 1, why: "a writer that holds the store until it is killed" },

  // Deadlines and watchdogs
  "evals/nightly.e2e.test.ts": { count: 1, why: "a watchdog that kills a run that hangs" },
  "packages/core/test/telemetry/script.e2e.test.ts": { count: 1, why: "a watchdog that kills a script that hangs" },
  "test/release/feature-docs-3.e2e.test.ts": { count: 1, why: "a watchdog that kills a run that hangs" },
}

/** Test code: test files, their helpers and fixtures. The eval tasks' workspaces are the agent's material, not tests. */
function testFiles(): string[] {
  const listed = [...new Bun.Glob("**/*.ts").scanSync({ cwd: ROOT })].map((path) => path.split("\\").join("/"))
  return listed
    .filter((path) => !/(^|\/)(node_modules|dist)\//.test(path) && !/^evals\/tasks\//.test(path))
    .filter((path) => /(^|\/)test\//.test(path) || path.endsWith(".test.ts"))
    // This file's examples are the patterns it looks for.
    .filter((path) => path !== "test/release/test-waits.test.ts")
    .sort()
}

/** The argument list of the call whose opening parenthesis is at `open`, split at its top-level commas. */
function argumentsAt(source: string, open: number): string[] | null {
  const parts: string[] = []
  let depth = 0
  let start = open + 1
  let quote: string | null = null
  for (let index = open; index < source.length; index++) {
    const char = source[index]!
    if (quote !== null) {
      if (char === "\\") index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") {
      depth--
      if (depth === 0) {
        parts.push(source.slice(start, index).trim())
        return parts
      }
    } else if (char === "," && depth === 1) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  return null
}

/** Each timed wait in `source`: a sleep, a call to a local `sleep`, or a timer with a delay. Zero-delay yields are not waits. */
export function timedWaits(source: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = []
  const pattern = /\b(Bun\.sleep(?:Sync)?|setTimeout|sleep)\(/g
  for (const match of source.matchAll(pattern)) {
    const before = source[match.index - 1]
    // `sleep(` as a method or a part of a longer name (`clock.sleep(`, `asleep(`) is not a wait of the test's own.
    if (match[1] === "sleep" && before !== undefined && /[\w.]/.test(before)) continue
    const args = argumentsAt(source, match.index + match[0].length - 1)
    if (args === null) continue
    const delay = match[1] === "setTimeout" ? (args[1] ?? "0") : (args[0] ?? "")
    if (/^0$/.test(delay)) continue
    // A local helper's definition is counted where it is called, not where it is defined.
    if (match[1] === "setTimeout" && /^(ms|delayMs|intervalMs)$/.test(delay) && /=>\s*new Promise/.test(source.slice(Math.max(0, match.index - 80), match.index))) continue
    const line = source.slice(0, match.index).split("\n").length
    found.push({ line, text: source.split("\n")[line - 1]!.trim() })
  }
  return found
}

describe("timed waits in tests", () => {
  test("the scanner counts sleeps and delayed timers, not yields", () => {
    const waits = timedWaits(
      [
        "await Bun.sleep(300)",
        "await Bun.sleep(0)",
        "await new Promise((resolve) => setTimeout(resolve, 20))",
        "await new Promise((resolve) => setTimeout(resolve, 0))",
        "setTimeout(() => controller.abort(), 100)",
        "setTimeout(done)",
        "await sleep(40)",
        "await this.clock.sleep(1000)",
        "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))",
        // Code in a string counts too: tests run such strings as child scripts.
        'const child = "await Bun.sleep(60_000)"',
      ].join("\n"),
    )
    expect(waits.map((wait) => wait.line)).toEqual([1, 3, 5, 7, 10])
  })

  test("each test file has only the timed waits listed for it, and the list is not stale", () => {
    const problems: string[] = []
    const files = testFiles()
    const counted = new Map<string, { line: number; text: string }[]>()
    for (const path of files) {
      const waits = timedWaits(readFileSync(join(ROOT, path), "utf8"))
      if (waits.length > 0) counted.set(path, waits)
    }
    for (const [path, waits] of counted) {
      const allowed = ALLOWED[path]?.count ?? 0
      if (waits.length > allowed)
        problems.push(
          `${path}: ${waits.length} timed wait(s), ${allowed} allowed. Wait for the state the test means with waitFor (@windlass/core/testing); if time itself is what is tested, list it in ${import.meta.file} with the reason:\n${waits.map((wait) => `  ${path}:${wait.line}  ${wait.text}`).join("\n")}`,
        )
    }
    for (const [key, entry] of Object.entries(ALLOWED)) {
      const found = counted.get(key)?.length ?? 0
      if (found < entry.count) problems.push(`${key}: ${entry.count} allowed but ${found} found; lower the count in ${import.meta.file}`)
      if (!files.includes(key)) problems.push(`${key}: listed in ${import.meta.file} but no such test file`)
    }
    expect(problems).toEqual([])
  })
})

describe("end-to-end tests", () => {
  const files = testFiles().filter((path) => path.endsWith(".test.ts"))

  test("a test file that starts a process itself is named *.e2e.test.ts", () => {
    const starts = files.filter((path) => !path.endsWith(".e2e.test.ts") && /\bBun\.spawn(Sync)?\(|from "node:child_process"/.test(readFileSync(join(ROOT, path), "utf8")))
    expect(starts).toEqual([])
  })

  test("every end-to-end file sets a time limit sized for a slow runner", () => {
    const missing = files.filter((path) => path.endsWith(".e2e.test.ts") && !/\bsetDefaultTimeout\(/.test(readFileSync(join(ROOT, path), "utf8")))
    expect(missing).toEqual([])
  })
})
