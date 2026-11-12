/**
 * What an undo or a redo says about the files it asks about: a file that
 * changed while a command or the checks of the session ran, and that no tool
 * call named, is said to have changed then, in the question and in the plan
 * the conversation shows; other changes keep the shared sentences.
 */
import { afterEach, expect, test } from "bun:test"
import type { RevertPlan } from "@windlass/core"
import { handEditLines } from "../src/features.ts"
import { flat } from "./builders.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

test("the question says which files changed while a command ran, apart from those changed by the user or under another session", () => {
  const lines = handEditLines(
    [
      { path: "notes.md", handEdited: true, editedBy: { kind: "unknown" } },
      { path: "out/report.txt", handEdited: true, editedBy: { kind: "unknown" } },
      { path: "README.md", handEdited: true, editedBy: { kind: "outside" } },
      { path: "src/a.ts", handEdited: false },
    ],
    "since the turn",
  )
  expect(lines).toEqual(["1 file changed since the turn by you or another program: README.md", "2 files changed while a command ran (or the checks), which may be the command's own work or yours: notes.md, out/report.txt"])
  expect(handEditLines([{ path: "notes.md", handEdited: true, editedBy: { kind: "unknown" } }], "since the /undo")).toEqual(["1 file changed while a command ran (or the checks), which may be the command's own work or yours: notes.md"])
  expect(handEditLines([{ path: "src/a.ts", handEdited: false }], "since the turn")).toEqual([])
})

test("/undo shows the plan with such a file marked as changed while a command ran", async () => {
  const backend = new ScriptBackend()
  const plan = {
    fromSeq: 4,
    messageId: null,
    messages: 3,
    target: "snap_1",
    unrestorable: null,
    changes: [
      { path: "notes.md", status: "modified", handEdited: true, editedBy: { kind: "unknown" } },
      { path: "README.md", status: "modified", handEdited: true, editedBy: { kind: "outside" } },
      { path: "src/a.ts", status: "modified", handEdited: false },
    ],
    kept: [],
  } as unknown as RevertPlan
  backend.prepare = (session) => {
    session.revert = async (options) => (options.dryRun === true ? { kind: "preview", plan } : { kind: "hand_edited", plan })
    session.undoRevert = session.revert
  }
  mounted = await mount({ width: 170, height: 40, backend })
  await mounted.setup.mockInput.typeText("/undo")
  mounted.setup.mockInput.pressEnter()
  await mounted.settle()
  const frame = flat(await mounted.frame())
  expect(frame).toContain("notes.md (changed while a command ran)")
  expect(frame).toContain("README.md (changed outside this session)")
  expect(frame).toContain("nothing was changed")
})
