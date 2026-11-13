/** The default check runner on real commands: pass, fail, hang, large output, the sandbox, and a check through the scheduler. */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { detectSandbox } from "../../src/sandbox/detect.ts"
import { type CheckRequest, createCheckRunner } from "../../src/wake/check.ts"
import { createScheduler } from "../../src/wake/scheduler.ts"
import { MINUTE, SECOND, cleanup, inbox, manualClock, stopLater, store, tempDir } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(cleanup)

const UNSANDBOXED = { kind: "unsandboxed" as const }

function request(command: string, overrides: Partial<CheckRequest> = {}): CheckRequest {
  return { name: "wk_test", command, cwd: tempDir(), timeoutMs: 10 * SECOND, run: UNSANDBOXED, sessionId: "ses_1", signal: new AbortController().signal, ...overrides }
}

describe("outcomes", () => {
  test("a command that passes, and one that fails, with their output", async () => {
    const spill = tempDir()
    const run = createCheckRunner({ spillDir: spill })
    expect(await run(request("echo ready"))).toMatchObject({ kind: "exited", exitCode: 0, output: "ready\n", totalBytes: 6 })
    expect(await run(request("echo not yet >&2; exit 3"))).toMatchObject({ kind: "exited", exitCode: 3, output: "not yet\n" })
    // Nothing is left behind in the spill directory.
    expect(readdirSync(spill)).toEqual([])
  })

  test("the fingerprint changes with the output and with the exit code, and not otherwise", async () => {
    const run = createCheckRunner({ spillDir: tempDir() })
    const fingerprint = async (command: string) => {
      const outcome = await run(request(command))
      if (outcome.kind !== "exited") throw new Error(outcome.kind)
      return outcome.fingerprint
    }
    expect(await fingerprint("echo a")).toBe(await fingerprint("echo a"))
    expect(await fingerprint("echo a")).not.toBe(await fingerprint("echo b"))
    expect(await fingerprint("echo a")).not.toBe(await fingerprint("echo a; exit 1"))
  })

  test("a command that hangs is stopped at its timeout, with its child processes", async () => {
    const dir = tempDir()
    const run = createCheckRunner({ spillDir: tempDir(), graceMs: 200 })
    const started = performance.now()
    const outcome = await run(request(`(sleep 30; touch ${join(dir, "survived")}) & echo started; sleep 30`, { timeoutMs: 1000, cwd: dir }))
    expect(outcome).toMatchObject({ kind: "error", reason: "timed_out", message: "it did not finish within 1 seconds", output: "started\n" })
    expect(performance.now() - started).toBeLessThan(8000)
    await Bun.sleep(300)
    expect(existsSync(join(dir, "survived"))).toBe(false)
  })

  test("large output is shown as its beginning and end, and the fingerprint still covers all of it", async () => {
    const run = createCheckRunner({ spillDir: tempDir(), shownBytes: 1000 })
    const command = (last: string) => `seq 1 200000; echo ${last}`
    const outcome = await run(request(command("END-A")))
    if (outcome.kind !== "exited") throw new Error(outcome.kind)
    expect(outcome.totalBytes).toBeGreaterThan(1_000_000)
    expect(outcome.output.length).toBeLessThan(1200)
    expect(outcome.output.startsWith("1\n2\n3\n")).toBe(true)
    expect(outcome.output).toContain("bytes left out …]")
    expect(outcome.output.endsWith("END-A\n")).toBe(true)
    const other = await run(request(command("END-B")))
    expect(other.kind === "exited" && other.fingerprint).not.toBe(outcome.fingerprint)
  })

  test("a command that cannot be found, and a directory that does not exist, cannot start", async () => {
    const run = createCheckRunner({ spillDir: tempDir() })
    expect(await run(request("definitely-not-a-command-xyz"))).toMatchObject({ kind: "error", reason: "could_not_start" })
    expect(await run(request("true", { cwd: join(tempDir(), "missing") }))).toMatchObject({ kind: "error", reason: "could_not_start" })
  })

  test("a credential-looking value in the output is redacted before it can reach a message", async () => {
    const run = createCheckRunner({ spillDir: tempDir(), secrets: () => ["s3cr3t-value-123"] })
    const outcome = await run(request("echo token=s3cr3t-value-123"))
    expect(outcome.kind === "exited" && outcome.output).toBe("token=[REDACTED:env]\n")
  })

  test("stopping interrupts a running check", async () => {
    const controller = new AbortController()
    const run = createCheckRunner({ spillDir: tempDir(), graceMs: 200 })
    const pending = run(request("sleep 30", { signal: controller.signal }))
    await Bun.sleep(200)
    controller.abort()
    expect(await pending).toEqual({ kind: "interrupted" })
  })
})

describe("the sandbox", () => {
  test("a check recorded as sandboxed never runs without one", async () => {
    const run = createCheckRunner({ spillDir: tempDir() })
    expect(await run(request("true", { run: { kind: "sandboxed", network: false, writableRoots: [] } }))).toMatchObject({ kind: "error", reason: "sandbox_unavailable" })
    const none = createCheckRunner({
      spillDir: tempDir(),
      sandbox: createCommandSandbox({ detection: { available: false, backend: null, reason: "bubblewrap is not installed", remedy: null, detail: null }, tempBase: tempDir() }),
    })
    expect(await none(request("true", { run: { kind: "sandboxed", network: false, writableRoots: [] } }))).toMatchObject({
      kind: "error",
      reason: "sandbox_unavailable",
      message: "it must run in the sandbox, which is unavailable: bubblewrap is not installed",
    })
  })

  const sandboxAvailable = detectSandbox().available
  test.skipIf(!sandboxAvailable)("sandboxed: it writes its working directory, not outside it, and has no network", async () => {
    const workspace = tempDir()
    const outside = tempDir()
    const run = createCheckRunner({ spillDir: tempDir(), sandbox: createCommandSandbox({ tempBase: tempDir() }) })
    const offline = { kind: "sandboxed" as const, network: false, writableRoots: [] }
    expect(await run(request("echo ok > inside.txt && cat inside.txt", { cwd: workspace, run: offline }))).toMatchObject({ kind: "exited", exitCode: 0, output: "ok\n" })
    const blocked = await run(request(`echo no > ${join(outside, "x.txt")}`, { cwd: workspace, run: offline }))
    expect(blocked.kind === "exited" && blocked.exitCode).not.toBe(0)
    expect(existsSync(join(outside, "x.txt"))).toBe(false)
    // Even a server on this machine is out of reach without the network.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") })
    try {
      const probe = await run(request(`exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo reached`, { cwd: workspace, run: offline }))
      expect(probe.kind === "exited" && probe.output).not.toContain("reached")
    } finally {
      server.stop(true)
    }
  })
})

describe("through the scheduler", () => {
  test("a check that passes on its third run fires once with its output", async () => {
    const workspace = tempDir()
    writeFileSync(join(workspace, "count"), "0")
    const clock = manualClock()
    const wakes = store(clock)
    const box = inbox()
    const scheduler = createScheduler({ store: wakes, clock, runCheck: createCheckRunner({ spillDir: tempDir() }), deliver: box.deliver })
    stopLater(scheduler)
    const command = 'n=$(($(cat count) + 1)); echo $n > count; if [ $n -ge 3 ]; then echo "passed on run $n"; else echo "run $n: not yet"; exit 1; fi'
    const created = wakes.create({ sessionId: "ses_1", message: "CI is done.", author: "user", trigger: { kind: "check", command, intervalMs: MINUTE, fire: "until" }, run: UNSANDBOXED, cwd: workspace })
    if (!created.ok) throw new Error(created.error)
    for (let run = 0; run < 5; run += 1) {
      await scheduler.runDue()
      clock.advance(MINUTE)
    }
    expect(box.admitted).toHaveLength(1)
    expect(box.admitted[0]!.text).toContain("exited 0")
    expect(box.admitted[0]!.text).toContain("passed on run 3")
    expect(box.admitted[0]!.untrusted).toBe(true)
  })
})
