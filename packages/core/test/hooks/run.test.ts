/** Real hook commands through the real runner: the answer format, timeouts, garbage, the event on stdin, the sandbox. */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseAnswer } from "../../src/hooks/answer.ts"
import type { Hook } from "../../src/hooks/config.ts"
import { HOOK_ENV_PREFIX, hookEvent } from "../../src/hooks/event.ts"
import { runAfterHooks, runBeforeHooks, runStopHooks } from "../../src/hooks/points.ts"
import { STDOUT_READ_BYTES, createHookRunner } from "../../src/hooks/run.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { detectSandbox } from "../../src/sandbox/detect.ts"
import { cleanup, hooks, pointContext, tempDir, trust } from "./helpers.ts"

afterEach(cleanup)

const P = HOOK_ENV_PREFIX
const offline = { network: false, writableRoots: [] }

function stopHook(command: string, timeoutSeconds = 10): Hook {
  return hooks({ user: { stop: [{ name: "h", command, timeoutSeconds }] } }).stop[0]!
}

function run(command: string, options: { timeoutSeconds?: number; cwd?: string; signal?: AbortSignal; secrets?: string[] } = {}) {
  const spillDir = tempDir()
  const hook = stopHook(command, options.timeoutSeconds)
  const runner = createHookRunner({ spillDir, graceMs: 200, ...(options.secrets === undefined ? {} : { secrets: () => options.secrets! }) })
  const event = hookEvent({ point: "stop", sessionId: "ses_1", cwd: "/w", hook, round: 1, maxRounds: 3, lastText: "done" })
  return runner({ hook, event, cwd: options.cwd ?? tempDir(), sessionId: "ses_1", sandbox: null, signal: options.signal ?? new AbortController().signal }).then((result) => ({ result, spillDir }))
}

describe("the answer format, on real processes", () => {
  test("exit 0 and exit 2, with stdout told apart from stderr", async () => {
    const yes = await run("echo noise; echo progress >&2; exit 0")
    expect(yes.result).toMatchObject({ kind: "exited", exitCode: 0, stdout: "noise\n", stderr: "progress" })
    expect(parseAnswer(yes.result, 100)).toEqual({ kind: "yes" })
    const no = await run("echo 'debug line' >&2; printf 'Remove TODO.tmp first.'; exit 2")
    expect(no.result).toMatchObject({ kind: "exited", exitCode: 2, stdout: "Remove TODO.tmp first.", stderr: "debug line" })
    expect(parseAnswer(no.result, 100)).toEqual({ kind: "no", text: "Remove TODO.tmp first.", cut: false })
    // Nothing is left behind.
    expect(readdirSync(no.spillDir)).toEqual([])
  })

  test("an `exit` in the command ends the command, not the wrapper; multi-line commands work", async () => {
    const { result } = await run("if true; then\n  echo first\n  exit 2\nfi\necho never")
    expect(result).toMatchObject({ kind: "exited", exitCode: 2, stdout: "first\n" })
  })

  test("a crash is an error exit, a missing program could not start, a syntax error is never an answer", async () => {
    expect(parseAnswer((await run("echo oops >&2; exit 1")).result, 100)).toMatchObject({ kind: "failed", failure: "error_exit" })
    expect(parseAnswer((await run("definitely-not-a-command-xyz")).result, 100)).toMatchObject({ kind: "failed", failure: "could_not_start" })
    // bash reports a syntax error with exit 2, which must not read as "no".
    const syntax = await run("if then fi (")
    expect(syntax.result.kind).toBe("could_not_start")
    expect(parseAnswer(syntax.result, 100)).toMatchObject({ kind: "failed", failure: "could_not_start" })
  })

  test("garbage on stdout is a failure", async () => {
    const { result } = await run("printf 'bin\\001ary\\000'; exit 2")
    expect(parseAnswer(result, 100)).toMatchObject({ kind: "failed", failure: "garbage" })
  })

  test("a long answer is read in part, counted, and cut", async () => {
    const { result } = await run(`head -c ${STDOUT_READ_BYTES * 4} /dev/zero | tr '\\0' 'y'; exit 2`)
    expect(result).toMatchObject({ kind: "exited", exitCode: 2, stdoutBytes: STDOUT_READ_BYTES * 4 })
    if (result.kind === "exited") expect(result.stdout.length).toBe(STDOUT_READ_BYTES)
    expect(parseAnswer(result, 2000)).toMatchObject({ kind: "no", cut: true })
  })

  test("a hook that hangs is killed at its timeout", async () => {
    const started = performance.now()
    const { result } = await run("echo waiting >&2; sleep 30", { timeoutSeconds: 1 })
    expect(result).toMatchObject({ kind: "timed_out", timeoutSeconds: 1 })
    expect(performance.now() - started).toBeLessThan(10_000)
    expect(parseAnswer(result, 100)).toMatchObject({ kind: "failed", failure: "timed_out" })
  }, 15_000)

  test("an interrupt stops it", async () => {
    const interrupt = createInterrupt()
    setTimeout(() => interrupt.interrupt("user"), 300)
    const { result } = await run("sleep 30", { signal: interrupt.signal })
    expect(result).toEqual({ kind: "interrupted" })
  }, 15_000)

  test("secrets are redacted from what it printed", async () => {
    const secret = "s3cr3t-value-0123456789"
    const { result } = await run(`echo ${secret} >&2; echo "token ${secret}"; exit 2`, { secrets: [secret] })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  test("its output is redacted as it arrives: a cut never leaves half a value, and a replaced value is not a cut answer", async () => {
    const secret = "s3cr3t-value-0123456789"
    // The value sits where the kept end of stderr begins: cut first and redacted afterwards, its second half would stay.
    const cut = await run(`printf '%s' '${secret}' >&2; head -c 2030 /dev/zero | tr '\\0' x >&2; exit 0`, { secrets: [secret] })
    expect(JSON.stringify(cut.result)).not.toContain("0123456789")
    // An answer that holds a value: the placeholder is shorter than the value, and the answer is whole.
    const { result } = await run(`echo "the token is ${secret}, rotate it"; exit 2`, { secrets: [secret] })
    if (result.kind !== "exited") throw new Error(`expected an exit, got ${result.kind}`)
    expect(result.stdout.trim()).toMatch(/^the token is \[REDACTED:[a-z_-]+\], rotate it$/)
    expect(parseAnswer(result, 2000)).toEqual({ kind: "no", text: result.stdout.trim(), cut: false })
    // Written in two pieces: a value is replaced once it is whole, in the file the output is kept in while the hook runs too.
    const pieces = await run(`printf 's3cr3t-value-' >&2; sleep 0.3; printf '0123456789\n' >&2; exit 0`, { secrets: [secret] })
    expect(JSON.stringify(pieces.result)).not.toContain("0123456789")
  })
})

describe("what the hook is given", () => {
  test("the event on stdin and the environment, also with quotes and newlines in values", async () => {
    const cwd = tempDir()
    const out = join(cwd, "seen")
    const hook = hooks({ user: { beforeTool: [{ name: "spy", command: `cat > ${out}.json; printf '%s' "$${P}COMMAND" > ${out}.cmd; printf '%s' "$${P}TOOL" > ${out}.tool` }] } }).beforeTool[0]!
    const runner = createHookRunner({ spillDir: tempDir() })
    const command = `echo 'it''s' "two\nlines" $HOME; ${P}EVENT_x`
    const outcome = await runBeforeHooks(pointContext(runner, { cwd, trust: trust({ mode: "full" }) }), [hook], { tool: "shell", callId: "c1", arguments: { command }, paths: null })
    expect(outcome.decision).toEqual({ kind: "allow" })
    expect(JSON.parse(await Bun.file(`${out}.json`).text()).tool.arguments).toEqual({ command })
    expect(await Bun.file(`${out}.cmd`).text()).toBe(command)
    expect(await Bun.file(`${out}.tool`).text()).toBe("shell")
  })
})

describe("the three points, end to end on real commands", () => {
  test("block git push; format after an edit; refuse to end while a file exists", async () => {
    const cwd = tempDir()
    const config = hooks({
      user: {
        beforeTool: [{ name: "no-push", tools: ["shell"], command: `case "$${P}COMMAND" in *"git push"*) echo "Pushing is not allowed here; commit locally."; exit 2;; esac` }],
        afterTool: [{ name: "format", tools: ["edit", "write"], command: `printf '%s\\n' "$${P}PATHS" | while read -r f; do sed -i 's/[ ]*$//' "$f"; done; echo "Trimmed trailing spaces in $${P}PATHS."; exit 2` }],
        stop: [{ name: "no-scratch", command: "if [ -e SCRATCH.md ]; then echo 'Delete SCRATCH.md before you finish.'; exit 2; fi" }],
      },
    })
    const context = pointContext(createHookRunner({ spillDir: tempDir() }), { cwd, trust: trust({ mode: "full" }) })

    const push = await runBeforeHooks(context, config.beforeTool, { tool: "shell", callId: "c1", arguments: { command: "git push origin main" }, paths: null })
    expect(push.decision).toMatchObject({ kind: "refuse", output: 'This call was not run: the hook "no-push" refused it.\nPushing is not allowed here; commit locally.' })
    expect((await runBeforeHooks(context, config.beforeTool, { tool: "shell", callId: "c2", arguments: { command: "git status" }, paths: null })).decision).toEqual({ kind: "allow" })

    writeFileSync(join(cwd, "a.ts"), "const a = 1   \n")
    const edited = { status: "success" as const, output: "Edited a.ts.", truncation: null, attachments: [], display: null }
    const after = await runAfterHooks(context, config.afterTool, { tool: "edit", callId: "c3", arguments: { path: "a.ts" }, paths: ["a.ts"] }, edited)
    expect(after.result.output).toBe('Edited a.ts.\n\n[Note from the hook "format"]\nTrimmed trailing spaces in a.ts.')
    expect(await Bun.file(join(cwd, "a.ts")).text()).toBe("const a = 1\n")

    writeFileSync(join(cwd, "SCRATCH.md"), "notes")
    const blocked = await runStopHooks(context, config.stop, { roundsSent: 0, maxRounds: 3, lastText: "Done." })
    expect(blocked.decision).toMatchObject({ kind: "continue", round: 1 })
    if (blocked.decision.kind === "continue") expect(blocked.decision.message).toContain("Delete SCRATCH.md before you finish.")
    await Bun.file(join(cwd, "SCRATCH.md")).delete()
    expect((await runStopHooks(context, config.stop, { roundsSent: 1, maxRounds: 3, lastText: "Done." })).decision).toEqual({ kind: "end", failed: [] })
  }, 30_000)
})

const sandboxAvailable = detectSandbox().available

describe("the sandbox", () => {
  test("a hook planned in the sandbox never runs without one", async () => {
    const hook = stopHook("touch should-not-exist")
    const cwd = tempDir()
    const event = hookEvent({ point: "stop", sessionId: "ses_1", cwd, hook, round: 1, maxRounds: 3, lastText: "" })
    const none = createHookRunner({ spillDir: tempDir() })
    expect(await none({ hook, event, cwd, sessionId: "ses_1", sandbox: offline, signal: new AbortController().signal })).toMatchObject({ kind: "cannot_run" })
    const missing = createHookRunner({
      spillDir: tempDir(),
      sandbox: createCommandSandbox({ detection: { available: false, backend: null, reason: "bubblewrap is not installed", remedy: null, detail: null }, tempBase: tempDir() }),
    })
    expect(await missing({ hook, event, cwd, sessionId: "ses_1", sandbox: offline, signal: new AbortController().signal })).toEqual({
      kind: "cannot_run",
      message: "it must run in the sandbox, which is unavailable: bubblewrap is not installed",
    })
    expect(existsSync(join(cwd, "should-not-exist"))).toBe(false)
  })

  test.skipIf(!sandboxAvailable)("sandboxed: it gets its event, writes the workspace, not outside it, and has no network", async () => {
    const cwd = tempDir()
    const outside = tempDir()
    const sandbox = createCommandSandbox({ tempBase: tempDir() })
    const runner = createHookRunner({ spillDir: tempDir(), sandbox })
    const command = [
      `read -r event; printf '%s' "$event" > event.json`,
      `touch ${outside}/escaped 2>/dev/null && echo "wrote outside"`,
      `(exec 3<>/dev/tcp/1.1.1.1/53) 2>/dev/null && echo "network"`,
      `echo "sandboxed answer"; exit 2`,
    ].join("\n")
    const config = hooks({ project: { stop: [{ name: "repo", command }] } })
    const context = pointContext(runner, { cwd, trust: trust({ mode: "auto", isApproved: () => true }) })
    const { decision, records } = await runStopHooks(context, config.stop, { roundsSent: 0, maxRounds: 3, lastText: "Done." })
    expect(records[0]).toMatchObject({ run: { kind: "ran", sandbox: offline }, answer: "no", toModel: "sandboxed answer" })
    expect(decision).toMatchObject({ kind: "continue" })
    expect(JSON.parse(await Bun.file(join(cwd, "event.json")).text())).toMatchObject({ point: "stop", hook: { name: "repo", origin: "project" } })
    expect(existsSync(join(outside, "escaped"))).toBe(false)
  }, 30_000)
})
