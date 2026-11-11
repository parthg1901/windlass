/**
 * Revert: while the session is idle, the user goes back to the state before
 * a message. The workspace is restored from the snapshot that was current
 * when that message was delivered, and the message and everything after it
 * leave the model's history. Nothing is deleted: the rows stay, flagged, and
 * the snapshot taken right before the restore is the undo point.
 *
 * A restore is announced before it touches a file (`revert.started`) and
 * recorded together with the change to history (`history.reverted`), so a
 * process that dies in between leaves a revert that the next one finishes.
 */
import {
  type Scenario,
  executionStarted,
  executionSucceeded,
  historyRestored,
  historyReverted,
  openingIn,
  restore,
  revertStarted,
  say,
  snap,
  stepEnded,
  stepStarted,
  undoStarted,
  wrote,
} from "./script.ts"

const FILES = { "notes.md": "# Notes\n" }
export const EDIT = '{"path":"notes.md","content":"# Notes\\n\\n- reviewed\\n"}'

/** One turn that changes notes.md: seq 1..17. `u1` has seq 6; the workspace goes from w0 to w1. */
const turn = [
  ...openingIn("Add a line to the notes."),
  ...wrote("a1", EDIT, "Wrote notes.md", "w0", "w1"),
  stepStarted("a2"),
  say("a2", "Added the line."),
  stepEnded("a2"),
  executionSucceeded(),
]
const U1 = 6
/** The revert: the workspace is recorded (the undo point), the restore announced, carried out and recorded with the range. Seq 18..21. */
const revert = [
  snap("restore_start", "w1"),
  revertStarted(U1, "w0", "w1"),
  snap("restore_end", "w0"),
  historyReverted(U1, restore("w0", "w1", 1)),
]
const REVERTED = turn.length + revert.length

export const revertLastTurn: Scenario = {
  title: "Revert of the last turn",
  description:
    "The user undoes the turn. The harness records the workspace as it is (so the revert itself can be undone), announces the restore, puts the files back as they were when the prompt was delivered, and records the restore together with the range that leaves history. The next request does not extend the previous one, which `history.reverted` allows.",
  provider: "one turn: write, answer. Then the user reverts it; the model is not called",
  setup: { files: FILES },
  phases: [
    {
      label: "the turn",
      events: turn,
      expect: { execution: null, history: ["u1", "a1", "a2"], undoable: 0 },
    },
    {
      label: "the revert is announced",
      events: revert.slice(0, 2),
      expect: { open: "revert", history: ["u1", "a1", "a2"] },
      rejects: [
        { event: executionStarted("exe_2"), code: "invalid_transition", why: "nothing starts while a restore is in progress" },
        {
          event: historyReverted(U1, restore("w0", "w9", 1)),
          code: "invalid_transition",
          why: "the record must be of the restore that was announced, with its undo point",
        },
      ],
    },
    {
      label: "the files are back and the turn has left history",
      events: revert.slice(2),
      expect: {
        open: null,
        history: [],
        undoable: 1,
        ui: [
          { id: "u1", excluded: "reverted" },
          { id: "a1", excluded: "reverted" },
          { id: "a2", excluded: "reverted" },
        ],
      },
    },
  ],
}

export const revertThenUndo: Scenario = {
  title: "Revert, then undo the revert",
  description:
    "The user reverts the turn and then changes their mind. Undoing the revert restores the workspace to the snapshot taken right before it and puts exactly the messages it excluded back into history. Only the latest revert can be undone, and only until new work starts.",
  provider: "one turn: write, answer. Then the user reverts it and undoes the revert; the model is not called",
  setup: { files: FILES },
  phases: [
    {
      label: "the turn is reverted",
      events: [...turn, ...revert],
      expect: { history: [], undoable: 1 },
      rejects: [
        { event: undoStarted(REVERTED - 2, "w1", "w0"), code: "invalid_transition", why: "an undo names the revert it undoes by the seq of its history.reverted" },
        { event: undoStarted(REVERTED, "w0", "w0"), code: "invalid_transition", why: "the undo restores the snapshot taken before that revert" },
      ],
    },
    {
      label: "the undo is announced",
      events: [snap("restore_start", "w0"), undoStarted(REVERTED, "w1", "w0")],
      expect: { open: "undo" },
    },
    {
      label: "the files and the turn are back",
      events: [snap("restore_end", "w1"), historyRestored(REVERTED, restore("w1", "w0", 1))],
      expect: {
        open: null,
        history: ["u1", "a1", "a2"],
        undoable: 0,
        ui: [
          { id: "u1", excluded: null },
          { id: "a1", excluded: null },
          { id: "a2", excluded: null },
        ],
      },
    },
  ],
}

export const revertScenarios = [revertLastTurn, revertThenUndo]
