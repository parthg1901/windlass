import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { type ReplayPolicy, STOPPED_OUTPUT, createReplay } from "../../src/replay/replay.ts"
import type { Tape } from "../../src/replay/tape.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { noBlobStore } from "../../src/tool/tool.ts"
import { beforeSideEffectReports, whileToolArgumentsStream } from "../scenarios/cancel.ts"
import { severalSteps } from "../scenarios/happy.ts"
import { identicalCallGuard } from "../scenarios/retry.ts"
import { EFFECT_UNKNOWN, NOT_STARTED } from "../scenarios/script.ts"
import { removeTempDirs, standIns, tapeOf, tempDir, toolCall } from "./helpers.ts"

afterEach(removeTempDirs)

/** A recording made in a real directory, and a throwaway copy beside it. */
function workspaces() {
  const root = tempDir()
  const original = join(root, "original")
  const copy = join(root, "copy")
  mkdirSync(original)
  mkdirSync(copy)
  return { root, original, copy }
}

function withCwd(tape: Tape, cwd: string): Tape {
  return { ...tape, cwd }
}

describe("replaying executor", () => {
  test("a matched call returns the recorded settlement byte for byte without running, and starts iff the recording did", async () => {
    const { runs, tools } = standIns()
    const replay = createReplay(tapeOf(severalSteps), { tools })
    const started: number[] = []
    const [outcome] = await replay.executor.runAll([toolCall("read", '{"path":"a.test.ts"}')], { onStart: (index) => started.push(index) })
    expect(outcome).toEqual({
      kind: "completed",
      settlement: { outcome: "success", output: "expect(add(1, 1)).toBe(3)", truncation: null, attachments: [], display: null },
    })
    expect(started).toEqual([0])
    expect(runs).toEqual([])
  })

  test("recorded not_started, effect_unknown and refused outcomes come back as the runtime's outcome kinds", async () => {
    const { tools } = standIns()
    const notRun = createReplay(tapeOf(whileToolArgumentsStream), { tools })
    let starts = 0
    expect(await notRun.executor.run(toolCall("read", '{"path":"a.ts"}'), { onStart: () => (starts += 1) })).toMatchObject({
      kind: "not_started",
      settlement: { outcome: "not_started", output: NOT_STARTED },
    })
    expect(starts).toBe(0)

    const unknown = createReplay(tapeOf(beforeSideEffectReports), { tools })
    expect(await unknown.executor.run(toolCall("write", '{"path":"a.ts","content":"export const a = 2"}'))).toMatchObject({
      kind: "crashed",
      settlement: { outcome: "effect_unknown", output: EFFECT_UNKNOWN },
    })

    const guarded = createReplay(tapeOf(identicalCallGuard), { tools })
    for (const _ of [1, 2]) {
      await guarded.executor.run(toolCall("read", '{"path":"a.ts"}'))
      guarded.endStep({ text: "", calls: [{ name: "read", input: '{"path":"a.ts"}' }], usage: null })
    }
    expect(await guarded.executor.run(toolCall("read", '{"path":"a.ts"}'))).toMatchObject({
      kind: "refused",
      reason: "invalid_arguments",
      settlement: { outcome: "error", output: expect.stringContaining("already ran twice") },
    })
  })

  test("stop (the default): a mismatched call runs nothing, settles not_started and stops the replay", async () => {
    const { runs, tools } = standIns()
    const stops: string[] = []
    const replay = createReplay(tapeOf(severalSteps), { tools, onStop: (divergence) => stops.push(divergence.kind) })
    const outcomes = await replay.executor.runAll([toolCall("read", '{"path":"a.test.ts"}'), toolCall("shell", '{"command":"rm -rf /"}', "/repo", 2)])
    expect(outcomes.map((outcome) => [outcome.kind, outcome.settlement.output])).toEqual([
      ["completed", "expect(add(1, 1)).toBe(3)"],
      ["not_started", STOPPED_OUTPUT],
    ])
    expect(runs).toEqual([])
    expect(replay.status).toBe("stopped")
    expect(stops).toEqual(["extra_call"])
    expect((await replay.executor.run(toolCall("write", "{}"))).kind).toBe("not_started")
    expect(replay.endStep({ text: "", calls: [{ name: "read", input: "" }, { name: "shell", input: "" }, { name: "write", input: "" }], usage: null }).action).toBe("stop")
  })

  test("execute-read-only runs a mismatched read in the copy, and stops at a mismatched write", async () => {
    const { original, copy } = workspaces()
    const real = standIns()
    const runtime = createToolRuntime({ tools: real.tools, spillDir: join(copy, ".spill"), putBlob: noBlobStore })
    const replay = createReplay(withCwd(tapeOf(severalSteps), original), {
      tools: real.tools,
      policy: { kind: "execute-read-only", workspace: { cwd: copy, runtime } },
    })
    const read = await replay.executor.run(toolCall("read", '{"path":"other.ts"}', original))
    expect(read).toMatchObject({ kind: "completed", settlement: { output: `ran read in ${copy}` } })
    expect(replay.status).toBe("off_tape")
    replay.endStep({ text: "", calls: [{ name: "read", input: '{"path":"other.ts"}' }], usage: null })
    const write = await replay.executor.run(toolCall("write", '{"path":"a.ts"}', original))
    expect(write.settlement.output).toBe(STOPPED_OUTPUT)
    expect(real.runs.map((run) => [run.name, run.cwd])).toEqual([["read", copy]])
    expect(replay.status).toBe("stopped")
    expect(replay.report().reason).toContain("execute-read-only runs only read tools")
  })

  test("execute runs a mismatched write for real, in the copy", async () => {
    const { original, copy } = workspaces()
    const real = standIns()
    const runtime = createToolRuntime({ tools: real.tools, spillDir: join(copy, ".spill"), putBlob: noBlobStore })
    const replay = createReplay(withCwd(tapeOf(severalSteps), original), { tools: real.tools, policy: { kind: "execute", workspace: { cwd: copy, runtime } } })
    let started = false
    const outcome = await replay.executor.run(toolCall("write", '{"path":"a.ts","content":"x"}', original), { onStart: () => (started = true) })
    expect(outcome).toMatchObject({ kind: "completed", settlement: { output: `ran write in ${copy}` } })
    expect(started).toBe(true)
    expect(real.runs).toEqual([{ name: "write", cwd: copy, input: { path: "a.ts", content: "x" } }])
    expect(replay.snapshot().offTape.executed).toBe(1)
  })

  test("a side-effecting call that names the original workspace is refused even under execute", async () => {
    const { original, copy } = workspaces()
    const real = standIns()
    const runtime = createToolRuntime({ tools: real.tools, spillDir: join(copy, ".spill"), putBlob: noBlobStore })
    const replay = createReplay(withCwd(tapeOf(severalSteps), original), { tools: real.tools, policy: { kind: "execute", workspace: { cwd: copy, runtime } } })
    const outcome = await replay.executor.run(toolCall("shell", JSON.stringify({ command: `rm -rf ${original}/src` }), original))
    expect(outcome.settlement.output).toBe(STOPPED_OUTPUT)
    expect(real.runs).toEqual([])
    expect(replay.status).toBe("stopped")
  })

  test("anything but stop requires a workspace that is not the original, inside it, around it or a link to it", () => {
    const { root, original, copy } = workspaces()
    const real = standIns()
    const runtime = createToolRuntime({ tools: real.tools, spillDir: join(copy, ".spill"), putBlob: noBlobStore })
    const tape = withCwd(tapeOf(severalSteps), original)
    const inside = join(original, "tmp")
    mkdirSync(inside)
    const link = join(root, "link")
    symlinkSync(original, link)
    const attempt = (policy: unknown) => () => createReplay(tape, { tools: real.tools, policy: policy as ReplayPolicy })
    expect(attempt({ kind: "execute" })).toThrow("needs an explicit workspace override")
    expect(attempt({ kind: "execute-read-only" })).toThrow("needs an explicit workspace override")
    expect(attempt({ kind: "execute", workspace: { cwd: original, runtime } })).toThrow("overlaps the recorded workspace")
    expect(attempt({ kind: "execute", workspace: { cwd: inside, runtime } })).toThrow("overlaps")
    expect(attempt({ kind: "execute", workspace: { cwd: root, runtime } })).toThrow("overlaps")
    expect(attempt({ kind: "execute", workspace: { cwd: link, runtime } })).toThrow("overlaps")
    expect(attempt({ kind: "execute", workspace: { cwd: "copy", runtime } })).toThrow("must be an absolute path")
    expect(attempt({ kind: "execute", workspace: { cwd: join(root, "missing"), runtime } })).toThrow("does not exist")
    expect(attempt({ kind: "execute", workspace: { cwd: copy, runtime } })).not.toThrow()
    expect(attempt({ kind: "stop" })).not.toThrow()
  })
})
