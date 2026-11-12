/**
 * The comparison on side effects and outcome (`replay/effects.ts`), on
 * hand-written tapes: which calls count as looks, how acts are matched, and
 * when a look off the recording could be answered from it without lying
 * about the workspace.
 */
import { describe, expect, test } from "bun:test"
import type { NewEvent } from "../../src/event/durable.ts"
import type { ToolOutcome } from "../../src/event/durable.ts"
import { classifyCall, compareEffects, finalSnapshot, lenientWalk, readOnlyCommand, renderComparison } from "../../src/replay/effects.ts"
import { normalise } from "../../src/replay/match.ts"
import type { TapeCall } from "../../src/replay/tape.ts"
import type { ToolEffect } from "../../src/tool/tool.ts"
import {
  called,
  deliver,
  enqueue,
  executionStarted,
  executionSucceeded,
  opening,
  replayDiverged,
  replayEnded,
  say,
  settled,
  stepEnded,
  stepInterrupted,
  stepStarted,
  toolStartedAs,
} from "../scenarios/script.ts"
import { tapeOf } from "./helpers.ts"

const EFFECT: Record<string, ToolEffect> = { read: "read", glob: "read", grep: "read", ls: "read", shell: "exec", write: "write", edit: "write" }

let ids = 0
/** One call that started and settled. */
const c = (name: string, args: Record<string, unknown>, outcome: ToolOutcome = "success") => ({ name, input: JSON.stringify(args), outcome, started: true })
/** A call that never started. */
const unstarted = (name: string, args: Record<string, unknown>) => ({ name, input: JSON.stringify(args), outcome: "not_started" as ToolOutcome, started: false })
type Call = ReturnType<typeof c>

/** A step of parallel calls. */
const step = (...calls: Call[]): NewEvent[] => {
  const id = `s${(ids += 1)}`
  return [
    stepStarted(id),
    ...calls.flatMap((call, index) => [
      called(id, `c${index}`, call.name, call.input),
      ...(call.started ? [toolStartedAs(id, `c${index}`, EFFECT[call.name] ?? "exec")] : []),
      settled(id, `c${index}`, call.outcome, `${call.name} ok`),
    ]),
    stepEnded(id, "tool_calls"),
  ]
}
const answer = (value = "Done."): NewEvent[] => {
  const id = `s${(ids += 1)}`
  return [stepStarted(id), say(id, value), stepEnded(id)]
}
const session = (...steps: NewEvent[][]) => tapeOf([...opening(), ...steps.flat(), executionSucceeded()])
/** A second turn: the user writes again. */
const nextTurn = (id: string): NewEvent[] => [executionSucceeded(), enqueue(id, "And now this."), executionStarted("exe_2"), deliver(id)]

const read = (path: string) => c("read", { path })
const write = (path: string, content: string) => c("write", { path, content })
const sh = (command: string, more: Record<string, unknown> = {}) => c("shell", { command, ...more })

const tapeCall = (call: Call): TapeCall => session(step(call)).steps[0]!.calls[0]!

describe("read-only commands", () => {
  test.each([
    "cat src/a.ts",
    "ls -la src",
    "grep -rn foo src | head -20",
    "sed -n '1,80p' src/a.ts",
    "git status && git diff --stat",
    "cd src && ls",
    'find . -name "*.ts" -not -path "./node_modules/*"',
    "cat a.txt 2>/dev/null || echo missing",
    "wc -l src/*.ts 2>&1",
    "LC_ALL=C sort data.txt | uniq -c",
    "rg -n 'getUsr\\b' .",
    "git log --oneline -5; git branch --show-current",
  ])("reads: %s", (command) => expect(readOnlyCommand(command)).toEqual({ readOnly: true }))

  test.each([
    ["echo x > a.txt", "redirect"],
    ["cat a >> b", "redirect"],
    ["sed -i s/a/b/ f.ts", "sed"],
    ["sed -n 's/a/b/w out' f.ts", "sed"],
    ["find . -name '*.tmp' -delete", "find"],
    ["find . -exec rm {} ;", "find"],
    ["bun test", "bun"],
    ["npm test", "npm"],
    ["rm a.txt", "rm"],
    ["git checkout src/a.ts", "git"],
    ["git branch -D old", "git branch"],
    ["git -c core.hooksPath=x status", "configuration"],
    ["sort -o out.txt a.txt", "sort"],
    ["cat <<EOF\nx\nEOF", "redirect"],
    ["echo $(rm a)", "substitute"],
    ["echo `rm a`", "substitute"],
    ["ls & rm a", "background"],
    ["cat a | tee b", "tee"],
    ["ls | xargs rm", "xargs"],
    ["cat 'unclosed", "quoting"],
    ["uniq in.txt out.txt", "uniq"],
    ["awk '{print}' a", "awk"],
    ["FOO=1", "assignments"],
  ])("does not read only: %s", (command, why) => {
    const verdict = readOnlyCommand(command)
    expect(verdict.readOnly).toBe(false)
    if (!verdict.readOnly) expect(verdict.why).toContain(why)
  })
})

describe("classes", () => {
  test("a read tool is a look; a write is an act", () => {
    expect(classifyCall(tapeCall(read("a.ts")))).toBe("look")
    expect(classifyCall(tapeCall(c("glob", { pattern: "*.ts" })))).toBe("look")
    expect(classifyCall(tapeCall(write("a.ts", "x")))).toBe("act")
  })

  test("a shell call is a look only when its command reads and it asks for nothing more", () => {
    expect(classifyCall(tapeCall(sh("cat a.ts")))).toBe("look")
    expect(classifyCall(tapeCall(sh("bun test")))).toBe("act")
    expect(classifyCall(tapeCall(sh("cat a.ts", { background: true })))).toBe("act")
    expect(classifyCall(tapeCall(sh("cat a.ts", { sandbox: { network: true } })))).toBe("act")
    expect(classifyCall(tapeCall(c("shell", { cmd: "cat a.ts" })))).toBe("act")
  })

  test("a write or edit that failed changed nothing; a call that never started did nothing; an unknown effect is an act", () => {
    expect(classifyCall(tapeCall(c("edit", { path: "a.ts", old_string: "x", new_string: "y" }, "error")))).toBe("none")
    expect(classifyCall(tapeCall(c("write", { path: "a.ts", content: "x" }, "error")))).toBe("none")
    expect(classifyCall(tapeCall(unstarted("write", { path: "a.ts", content: "x" })))).toBe("none")
    expect(classifyCall(tapeCall(c("write", { path: "a.ts", content: "x" }, "effect_unknown")))).toBe("act")
    // A failing command may have changed something before it failed.
    expect(classifyCall(tapeCall(c("shell", { command: "bun run migrate" }, "error")))).toBe("act")
    expect(classifyCall(tapeCall(c("deploy", {})))).toBe("act")
  })
})

describe("effects", () => {
  test("other looks, in another order and number, do not make a difference", () => {
    const recorded = session(step(read("a.ts")), step(sh("ls src")), step(write("a.ts", "fixed")), answer())
    const replayed = session(step(c("glob", { pattern: "**/*.ts" })), step(read("b.ts"), sh("cat a.ts")), step(write("a.ts", "fixed")), step(read("a.ts")), answer("Fixed it."))
    expect(compareEffects(recorded, replayed)).toMatchObject({ same: true, matched: 1, recorded: { acts: 1, looks: 2 }, replayed: { acts: 1, looks: 4 }, first: null })
  })

  test("parallel acts match in any order, and a recorded parallel step may be made one act at a time, or the other way round", () => {
    const parallel = session(step(write("a.ts", "1"), write("b.ts", "2")), answer())
    const serial = session(step(write("b.ts", "2")), step(write("a.ts", "1")), answer())
    expect(compareEffects(parallel, serial).same).toBe(true)
    expect(compareEffects(serial, parallel).same).toBe(true)
    expect(compareEffects(serial, session(step(write("a.ts", "1")), step(write("b.ts", "2")), answer())).first).toMatchObject({ kind: "act_differs" })
  })

  test("the first act without a partner is the difference, with its kind", () => {
    const recorded = session(step(write("a.ts", "fixed")), step(sh("bun test")), answer())
    expect(compareEffects(recorded, session(step(write("a.ts", "other")), answer())).first).toMatchObject({
      kind: "act_differs",
      recorded: { name: "write", step: 0 },
      replayed: { name: "write", step: 0 },
    })
    expect(compareEffects(recorded, session(step(write("a.ts", "fixed")), step(sh("bun test")), step(sh("bun test")), answer())).first).toMatchObject({ kind: "extra_act", recorded: null, replayed: { step: 2 } })
    expect(compareEffects(recorded, session(step(write("a.ts", "fixed")), answer()))).toMatchObject({ same: false, matched: 1, first: { kind: "missing_act", replayed: null, recorded: { name: "shell" } } })
  })

  test("paths are compared after the normalisers; a command's timeout is not part of it; a failed edit is not an act", () => {
    const recorded = session(step(write("a.ts", "x")), step(sh("bun test", { timeout: 60 })), answer())
    const replayed = session(step(c("edit", { path: "a.ts", old_string: "q", new_string: "x" }, "error")), step(write("/repo/a.ts", "x")), step(sh("bun test  ")), answer())
    expect(compareEffects(recorded, replayed).same).toBe(false)
    expect(compareEffects(recorded, replayed, { normalisers: { write: normalise.paths("path") } }).same).toBe(true)
  })
})

describe("lenient matching", () => {
  const verdicts = (walk: ReturnType<typeof lenientWalk>) => walk.answers.map((entry) => `${entry.look.argumentsText.slice(9, -2)}: ${entry.answer}`)

  test("a look the recording made at the same point is answered from it, in another order too", () => {
    const recorded = session(step(read("a.ts")), step(read("b.ts")), step(write("a.ts", "x")), answer())
    const replayed = session(step(read("b.ts")), step(read("a.ts")), step(write("a.ts", "x")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(verdicts(walk)).toEqual(["b.ts: served", "a.ts: served"])
    expect(walk).toMatchObject({ firstMustRun: null, effects: { same: true }, looks: { total: 2, served: 2, mustRun: 0 } })
  })

  test("a look no recorded call made must run for real: without a copy the lenient replay ends there", () => {
    const recorded = session(step(read("a.ts")), step(write("a.ts", "x")), answer())
    const replayed = session(step(read("a.ts")), step(read("c.ts")), step(write("a.ts", "x")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(verdicts(walk)).toEqual(["a.ts: served", "c.ts: must_run"])
    expect(walk.firstMustRun).toMatchObject({ step: 1, name: "read", why: "no identical call on the recording" })
    expect(walk.effects.same).toBe(true)
  })

  test("unsound: the recording read the file before its write; the replay reads it after the same write", () => {
    const recorded = session(step(read("a.ts")), step(write("a.ts", "x")), answer())
    const replayed = session(step(write("a.ts", "x")), step(read("a.ts")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(walk.answers[0]).toMatchObject({ answer: "must_run", why: "a recorded act lies between the identical recorded call and this point" })
  })

  test("unsound: the recording read the file after its write; the replay reads it before making the write", () => {
    const recorded = session(step(write("a.ts", "x")), step(read("a.ts")), answer())
    const replayed = session(step(read("a.ts")), step(write("a.ts", "x")), answer())
    expect(lenientWalk(recorded, replayed).answers[0]).toMatchObject({ answer: "must_run", why: "a recorded act lies between the identical recorded call and this point" })
  })

  test("unsound: the recorded read ran in parallel with a write, so it may have seen either state", () => {
    const recorded = session(step(read("a.ts"), write("a.ts", "x")), step(sh("bun test")), answer())
    const replayed = session(step(read("a.ts")), step(write("a.ts", "x")), step(sh("bun test")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(walk.answers[0]!.answer).toBe("must_run")
    expect(walk.effects.same).toBe(true)
  })

  test("unsound: the replay is halfway through a recorded step's parallel writes", () => {
    const recorded = session(step(read("b.ts")), step(write("a.ts", "1"), write("b.ts", "2")), answer())
    const replayed = session(step(write("a.ts", "1")), step(read("b.ts")), step(write("b.ts", "2")), answer())
    expect(lenientWalk(recorded, replayed).answers[0]).toMatchObject({ answer: "must_run", why: "the replay is halfway through a recorded step's parallel acts" })
  })

  test("unsound: the identical read was in another turn, and the user may have changed files in between", () => {
    const recorded = tapeOf([...opening(), ...step(read("a.ts")), ...answer(), ...nextTurn("u2"), ...answer("Nothing more."), executionSucceeded("exe_2")])
    const replayed = tapeOf([...opening(), ...answer(), ...nextTurn("u2"), ...step(read("a.ts")), ...answer("Nothing more."), executionSucceeded("exe_2")])
    expect(lenientWalk(recorded, replayed).answers[0]).toMatchObject({ answer: "must_run", why: "the identical recorded call is in another turn" })
  })

  test("unsound: a recorded read that never started, or was in a step the user cut, has no result to serve", () => {
    const recorded = tapeOf([...opening(), ...step(unstarted("read", { path: "a.ts" })), ...step(write("a.ts", "x")), executionSucceeded()])
    const replayed = session(step(read("a.ts")), step(write("a.ts", "x")), answer())
    expect(lenientWalk(recorded, replayed).answers[0]!.answer).toBe("must_run")
    const cut = tapeOf([...opening(), stepStarted("k1"), called("k1", "c0", "read", '{"path":"a.ts"}'), settled("k1", "c0", "not_started", "Not run"), stepInterrupted("k1", "user")])
    expect(cut.steps[0]!.response).toBe("cut")
    expect(lenientWalk(cut, session(step(read("a.ts")))).answers[0]!.answer).toBe("must_run")
  })

  test("after the replay made an act the recording did not, nothing more is answered from it, and the lenient replay left on that act", () => {
    const recorded = session(step(write("a.ts", "x")), step(read("a.ts")), answer())
    const replayed = session(step(write("a.ts", "y")), step(read("a.ts")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(walk.answers[0]).toMatchObject({ answer: "must_run", why: "the replay already made an act the recording did not" })
    expect(walk.firstMustRun).toBeNull()
    expect(walk.effects.first).toMatchObject({ kind: "act_differs" })
  })

  test("the looks of a step are judged before its own acts: a read parallel to a write sees the state before it", () => {
    const recorded = session(step(read("a.ts")), step(write("a.ts", "x")), answer())
    const replayed = session(step(read("a.ts"), write("a.ts", "x")), answer())
    expect(lenientWalk(recorded, replayed)).toMatchObject({ firstMustRun: null, effects: { same: true }, looks: { served: 1 } })
  })

  test("a read-only shell command is a look and can be served; a test run is an act and must match", () => {
    const recorded = session(step(sh("cat a.ts")), step(sh("bun test")), answer())
    const replayed = session(step(sh("cat a.ts ")), step(sh("bun test src/a.test.ts")), answer())
    const walk = lenientWalk(recorded, replayed)
    expect(walk.answers[0]!.answer).toBe("served")
    expect(walk.effects.first).toMatchObject({ kind: "act_differs", recorded: { name: "shell" } })
  })
})

describe("the workspace a replay ended with", () => {
  const taken = (id: string) => ({ type: "snapshot.taken", data: { id, point: "step_end", messageId: null } })
  test("a replay that never left ends with the recording's workspace; one that left, with its copy's last snapshot or the one it was restored from", () => {
    expect(finalSnapshot([replayEnded("identical", "")], "abc")).toBe("abc")
    expect(finalSnapshot([taken("early"), replayDiverged("arguments_differ", "restored"), taken("s1"), taken("s2"), replayEnded("diverged", "")], "abc")).toBe("s2")
    expect(finalSnapshot([replayDiverged("arguments_differ", "restored"), replayEnded("diverged", "")], "abc")).toBe("restored")
    expect(finalSnapshot([replayEnded("diverged", "")], "abc")).toBeNull()
  })
})

describe("the comparison as the replay report prints it", () => {
  test("says what was compared and what could not be", () => {
    expect(renderComparison({ effects: null, lenient: null, sameWorkspace: null })).toBe(
      [
        "compared on what it did (reads ignored)",
        "  side effects   not compared: the replay stopped before an answer of its own (use --policy execute)",
        "  files          not known (no copy, or no snapshot)",
      ].join("\n"),
    )
    expect(renderComparison({ effects: { same: false, matched: 1, recordedActs: 2, replayedActs: 3, first: 'act 2: shell "bun test" (extra act)' }, lenient: { served: 3, mustRun: 1, left: 'step 2 read "b.ts" (a look not on the recording)' }, sameWorkspace: true })).toBe(
      [
        "compared on what it did (reads ignored)",
        '  side effects   differ at act 2: shell "bun test" (extra act) (recorded 2, replayed 3)',
        '  lenient        would have left at step 2 read "b.ts" (a look not on the recording) (3 reads answerable from the recording, 1 not)',
        "  files          the same as the recording's at its end",
      ].join("\n"),
    )
  })
})
