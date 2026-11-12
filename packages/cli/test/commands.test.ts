/**
 * `/undo` and `/redo` in the interactive input: the editor runs them itself,
 * shows what they are about to do, asks before a file edited by hand is
 * overwritten, and hands everything else on as input.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { RevertOptions, RevertPlan, RevertResult } from "@light-harness/core"
import { type RevertableSession, askLocally, revertable, sessionCommand } from "../src/commands.ts"
import { type EditorAction, Screen } from "../src/terminal.ts"
import { VirtualTerminal } from "./vt.ts"

/** The session the next `setup()` attaches to its editor, as `main.ts` attaches the one it opened. */
let offered: RevertableSession | null = null
const offerSession = (session: RevertableSession | null) => {
  offered = session
}
afterEach(() => offerSession(null))

const plan = (changes: RevertPlan["changes"], more: Partial<RevertPlan> = {}): RevertPlan => ({
  fromSeq: 6,
  messageId: null,
  messages: 3,
  target: "w0",
  unrestorable: null,
  changes,
  kept: [],
  ...more,
})
const agentOnly = plan([
  { path: "src/add.ts", status: "modified", handEdited: false },
  { path: "src/new.ts", status: "deleted", handEdited: false },
])
const withHandEdit = plan([
  { path: "src/add.ts", status: "modified", handEdited: false },
  { path: "notes.md", status: "modified", handEdited: true },
])

/** What the engine does without a dry run: refuses to overwrite hand edits unless told how, as the real one does. */
const restored = (preview: RevertResult) => (options: RevertOptions): RevertResult => {
  const planned = (preview as { plan: RevertPlan }).plan
  if ((options.handEdits ?? "abort") === "abort" && planned.changes.some((change) => change.handEdited)) return { kind: "hand_edited", plan: planned }
  return { kind: "reverted", plan: planned, restore: null }
}

/**
 * A session whose engine answers a dry run with `preview` and records every
 * call it gets. The question about hand edits is put as the direct engine's
 * adapter puts it (`askLocally`).
 */
function session(preview: RevertResult, done: (options: RevertOptions) => RevertResult = restored(preview)) {
  const calls: string[] = []
  const answer = (name: string) => async (options: RevertOptions = {}) => {
    calls.push(`${name} ${JSON.stringify(options)}`)
    return options.dryRun ? preview : done(options)
  }
  const fake: RevertableSession = { revert: (options = {}) => askLocally(answer("revert"), options), undoRevert: (options = {}) => askLocally(answer("undoRevert"), options) }
  offerSession(fake)
  return calls
}

function setup(columns = 72) {
  const vt = new VirtualTerminal(columns)
  const screen = new Screen({ write: (text) => vt.write(text), columns: () => columns, color: false })
  screen.attach(offered)
  const actions: EditorAction[] = []
  screen.show("› ", "type a message")
  const type = async (data: string) => {
    screen.input(data, (action) => actions.push(action))
    // A command runs asynchronously up to its next question; let it get there.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  /** What the terminal shows, without the input line. */
  const output = () => vt.text.split("\n").slice(0, -1).filter((line) => line.trim() !== "")
  const prompt = () => vt.text.split("\n").at(-1)!
  return { vt, screen, actions, type, output, prompt }
}

describe("which sessions can revert", () => {
  test("one that has both revert and its undo; an engine without them offers no /undo", async () => {
    const calls = session({ kind: "preview", plan: agentOnly })
    const both = revertable(offered!)
    expect(both).not.toBeNull()
    await both!.revert({ dryRun: true })
    expect(calls).toEqual(['revert {"dryRun":true}'])
    expect(revertable({})).toBeNull()
    expect(revertable({ revert: offered!.revert })).toBeNull()
  })
})

describe("which entries are commands", () => {
  test("only /undo and /redo on their own", () => {
    expect(["/undo", "  /redo  ", "/undo now", "undo", "/exit", "/queue x", "/UNDO"].map(sessionCommand)).toEqual(["/undo", "/redo", null, null, null, null, null])
  })
})

describe("/undo", () => {
  test("shows what will be restored and does it, and the entry never reaches the turn", async () => {
    const calls = session({ kind: "preview", plan: agentOnly })
    const { type, actions, output, prompt } = setup()
    await type("/undo\r")
    expect(output()).toEqual(["↶ going back to before your last message · 3 messages", "  changed back to before the turn: src/add.ts", "  removed (the turn created it): src/new.ts"])
    expect(calls).toEqual(['revert {"dryRun":true}', 'revert {"handEdits":"abort"}'])
    expect(actions).toEqual([])
    expect(prompt()).toBe("› type a message")
  })

  test("asks before overwriting files edited by hand, and y overwrites them", async () => {
    const calls = session({ kind: "preview", plan: withHandEdit })
    const { type, actions, output, prompt, screen } = setup(120)
    await type("/undo\r")
    // What each answer does to the file, before it is asked: keep leaves the agent's change in it too.
    expect(output().slice(-4)).toEqual([
      "  1 file changed outside this session since the turn (by you, another program or another session): notes.md",
      "  y  overwrite: it goes back to before the turn and those changes are lost (/redo brings them back)",
      "  k  keep: it stays exactly as now, those changes and the agent's in it both; the other files go back",
      "  n  change nothing",
    ])
    expect(prompt()).toBe("[y] overwrite · [k] keep as they are now · [N] change nothing ›")
    // The engine found them when asked to change nothing that was edited by hand, and changed nothing.
    expect(calls).toEqual(['revert {"dryRun":true}', 'revert {"handEdits":"abort"}'])
    await type("y\r")
    expect(calls.at(-1)).toBe('revert {"handEdits":"overwrite"}')
    // The answer was the command's, not a message for the agent, and the usual prompt is back.
    expect(actions).toEqual([])
    expect(prompt()).toBe("› type a message")
    await screen.commandsSettled()
  })

  test("k keeps the hand-edited files and restores the rest", async () => {
    const calls = session({ kind: "preview", plan: withHandEdit })
    const { type } = setup()
    await type("/undo\r")
    await type("k\r")
    expect(calls.at(-1)).toBe('revert {"handEdits":"keep"}')
  })

  test("anything else, Enter alone or Ctrl-C changes nothing", async () => {
    for (const answer of ["n\r", "\r", "\x03", "\x04", "what?\r"]) {
      const calls = session({ kind: "preview", plan: withHandEdit })
      const { type, actions, output, prompt } = setup()
      await type("/undo\r")
      await type(answer)
      expect(calls).toEqual(['revert {"dryRun":true}', 'revert {"handEdits":"abort"}'])
      expect(output().at(-1)).toBe("  nothing was changed")
      // Ctrl-C answered the question; it did not interrupt anything or leave the program.
      expect(actions).toEqual([])
      expect(prompt()).toBe("› type a message")
    }
  })

  test("says when files cannot be restored and asks before rewinding the conversation alone", async () => {
    const calls = session({ kind: "preview", plan: plan([], { target: null, unrestorable: "no snapshot of the workspace was taken at that point" }) })
    const { type, output, prompt } = setup()
    await type("/undo\r")
    // A reason that does not fit the line is wrapped, never cut.
    expect(output().slice(-2)).toEqual(["  files are not restored: no snapshot of the workspace was taken at", "    that point"])
    expect(prompt()).toBe("rewind the conversation without restoring files? [y/N] ›")
    await type("yes\r")
    expect(calls.at(-1)).toBe('revert {"handEdits":"abort"}')
  })

  test("while the agent works, or with nothing to undo, it says so and changes nothing", async () => {
    const cases: [RevertResult, string][] = [
      [{ kind: "refused", reason: "busy", message: "the session can be reverted only while it is idle" }, "/undo works only while the agent is idle; stop it first (Ctrl-C)"],
      [{ kind: "refused", reason: "nothing_to_revert", message: "there is no turn to go back before" }, "there is no turn to undo"],
      [{ kind: "refused", reason: "compacted", message: "that message is behind the latest compaction, and a revert cannot reach back past it" }, "/undo: that message is behind the latest compaction, and a revert cannot reach back past it"],
      [{ kind: "failed", plan: null, message: "the workspace cannot be restored: not a snapshot" }, "/undo: the workspace cannot be restored: not a snapshot"],
    ]
    for (const [result, line] of cases) {
      const calls = session(result)
      const { type, output } = setup(120)
      await type("/undo\r")
      expect(output()).toEqual([line])
      expect(calls).toHaveLength(1)
    }
  })

  test("without a session that can revert it says so", async () => {
    const { type, output, actions } = setup()
    await type("/undo\r")
    expect(output()).toEqual(["/undo is not available with this engine"])
    expect(actions).toEqual([])
  })

  test("an engine that throws is reported, and the editor stays usable", async () => {
    offerSession({
      revert: async () => {
        throw new Error("the database is locked")
      },
      undoRevert: async () => ({ kind: "refused", reason: "nothing_to_revert", message: "" }),
    })
    const { type, output, actions } = setup()
    await type("/undo\r")
    expect(output()).toEqual(["/undo failed: the database is locked"])
    await type("hello\r")
    expect(actions).toEqual([{ kind: "submit", text: "hello" }])
  })
})

describe("/redo", () => {
  test("undoes the last /undo after saying what comes back", async () => {
    const calls = session({ kind: "preview", plan: plan([{ path: "src/add.ts", status: "modified", handEdited: false }, { path: "src/new.ts", status: "added", handEdited: false }]) })
    const { type, output } = setup()
    await type("/redo\r")
    // Said as what it does: the turn's changes go back in.
    expect(output()).toEqual(["↷ bringing back what the last /undo took away · 3 messages", "  the turn's changes put back: src/add.ts", "  brought back (the turn created it): src/new.ts"])
    expect(calls).toEqual(['undoRevert {"dryRun":true}', 'undoRevert {"handEdits":"abort"}'])
  })

  test("with nothing to redo it says so", async () => {
    session({ kind: "refused", reason: "nothing_to_revert", message: "there is no revert to undo" })
    const { type, output } = setup()
    await type("/redo\r")
    expect(output()).toEqual(["there is nothing to redo"])
  })
})

describe("everything else", () => {
  test("is handed on as before, while a question is not pending", async () => {
    session({ kind: "preview", plan: agentOnly })
    const { type, actions } = setup()
    await type("fix the test\r")
    await type("/queue then the docs\r")
    await type("/exit\r")
    await type("\x03")
    expect(actions).toEqual([{ kind: "submit", text: "fix the test" }, { kind: "submit", text: "/queue then the docs" }, { kind: "submit", text: "/exit" }, { kind: "interrupt" }])
  })
})
