/**
 * The review of a turn's diff. First as plain values (`src/review.ts`): the
 * rows of a patch with their line numbers, the cursor's moves by line, hunk
 * and file, comments written, edited, deleted and brought back, the screen at
 * fixed sizes, and the text of the message a review becomes. Then in the real
 * `App` on the test renderer, through a script backend: `/review`, a comment
 * on an added and on a removed line, the last look, the one message sent, a
 * review left and opened again, and the turns there is nothing to review of.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { DiffFile, DiffResult } from "@windlass/acp/extensions"
import { families } from "@windlass/core/testing/scenarios"
import { COMMENT_MARK, Review, type ReviewKey, ReviewScreen, fileLines, reviewMessage } from "../src/review.ts"
import { reviewTarget } from "../src/review-view.ts"
import { type Mounted, ScriptBackend, mount, stamp } from "./helpers.ts"

const file = (path: string, patch: string | null, more: Partial<DiffFile> = {}): DiffFile => ({
  path,
  status: "modified",
  binary: false,
  truncated: false,
  omitted: false,
  added: patch === null ? 0 : patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
  removed: patch === null ? 0 : patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  patch,
  ...more,
})

const ADD = file(
  "src/add.ts",
  [
    "diff --git a/src/add.ts b/src/add.ts",
    "index 1..2 100644",
    "--- a/src/add.ts",
    "+++ b/src/add.ts",
    "@@ -1,4 +1,4 @@",
    " export function add(a: number, b: number) {",
    "-  return a - b",
    "+  return a + b",
    " }",
    " ",
    "@@ -20,3 +20,4 @@ export function last() {",
    " // the end",
    "+// one more",
    " export {}",
    "\\ No newline at end of file",
    "",
  ].join("\n"),
)
const NOTES = file("notes.md", "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n", { status: "added" })
const LOGO = file("logo.png", null, { status: "added", binary: true })
const FILES = [ADD, LOGO, NOTES]

const key = (name: string, more: Partial<ReviewKey> = {}): ReviewKey => ({ name, sequence: name.length === 1 ? name : "", ctrl: false, meta: false, shift: false, ...more })
const text = (screen: ReviewScreen, columns: number, rows: number, typed = "") => screen.frame(columns, rows, typed).lines.map((line) => line.map((part) => part.text).join("").trimEnd())

describe("the rows of a diff", () => {
  test("a patch becomes its lines, numbered in the old and the new file; the headers before the first hunk are dropped", () => {
    const lines = fileLines(ADD, 0)
    expect(lines.map((line) => [line.kind, line.oldLine, line.newLine, line.text])).toEqual([
      ["file", null, null, "src/add.ts"],
      ["hunk", null, null, "@@ -1,4 +1,4 @@"],
      ["context", 1, 1, "export function add(a: number, b: number) {"],
      ["removed", 2, null, "  return a - b"],
      ["added", null, 2, "  return a + b"],
      ["context", 3, 3, "}"],
      ["context", 4, 4, ""],
      ["hunk", null, null, "@@ -20,3 +20,4 @@ export function last() {"],
      ["context", 20, 20, "// the end"],
      ["added", null, 21, "// one more"],
      ["context", 21, 22, "export {}"],
      ["note", null, null, "the line above has no newline at its end"],
    ])
    expect(lines.filter((line) => line.kind !== "file").map((line) => line.hunk)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1])
  })

  test("a file without a patch says what it is: binary, left out for size, cut, or with no changed line", () => {
    const says = (item: DiffFile) => fileLines(item, 0).filter((line) => line.kind === "note").map((line) => line.text)
    expect(says(LOGO)).toEqual(["binary file: it has no lines to show or comment on; a comment on the file's line above is about the file as a whole"])
    expect(says(file("big.json", null, { omitted: true }))[0]).toStartWith("its patch was left out: the diff of this turn is too large (the patch budget ran out before this file)")
    expect(says(file("run.sh", "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n", { status: "mode_changed" }))[0]).toStartWith("no line of the file changed: only its mode did")
    const cut = fileLines({ ...NOTES, truncated: true }, 0)
    expect(cut.at(-1)).toMatchObject({ kind: "note" })
    expect(cut.at(-1)!.text).toStartWith("cut here: the change to this file is larger than the per-file limit")
    expect(cut.filter((line) => line.kind === "added")).toHaveLength(2)
  })
})

describe("moving and commenting", () => {
  test("the cursor starts on the first changed line and stops only where a comment can go", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    const at = () => review.lines[review.cursor]!
    expect(at()).toMatchObject({ kind: "removed", oldLine: 2 })
    review.move(1)
    expect(at()).toMatchObject({ kind: "added", newLine: 2 })
    // Over the second hunk's header, which is no stop.
    review.move(3)
    expect(at()).toMatchObject({ kind: "context", newLine: 20 })
    review.toEnd()
    expect(at()).toMatchObject({ kind: "added", text: "two" })
    expect(review.move(1)).toBe(false)
    review.toStart()
    expect(at()).toMatchObject({ kind: "file", text: "src/add.ts" })
    expect(review.move(-1)).toBe(false)
  })

  test("by hunk: to the first changed line of the next or the previous one, across files; by file: to its own line", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    const at = () => review.lines[review.cursor]!
    expect(review.moveHunk(1)).toBe(true)
    expect(at()).toMatchObject({ kind: "added", newLine: 21 })
    expect(review.moveHunk(1)).toBe(true)
    expect(at()).toMatchObject({ kind: "added", text: "one" })
    expect(review.moveHunk(1)).toBe(false)
    expect(review.moveHunk(-1)).toBe(true)
    expect(at()).toMatchObject({ kind: "added", newLine: 21 })
    expect(review.moveFile(1)).toBe(true)
    expect(at()).toMatchObject({ kind: "file", text: "logo.png" })
    expect(review.moveFile(1)).toBe(true)
    expect(at()).toMatchObject({ kind: "file", text: "notes.md" })
    expect(review.moveFile(1)).toBe(false)
    review.move(1)
    // From inside a file, back goes to that file's own line first.
    expect(review.moveFile(-1)).toBe(true)
    expect(at()).toMatchObject({ kind: "file", text: "notes.md" })
  })

  test("a comment is written, edited, deleted and brought back; a removed line is numbered in the old file", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    expect(review.setComment("  ")).toBe("nothing")
    expect(review.setComment("why minus?\n")).toBe("saved")
    review.move(1)
    expect(review.setComment("good")).toBe("saved")
    expect(review.count).toBe(2)
    expect(review.ordered()).toEqual([
      { path: "src/add.ts", on: "removed", line: 2, quote: "  return a - b", text: "why minus?" },
      { path: "src/add.ts", on: "added", line: 2, quote: "  return a + b", text: "good" },
    ])
    expect(review.setComment("good: keep it")).toBe("saved")
    expect(review.commentAt()!.text).toBe("good: keep it")
    expect(review.count).toBe(2)
    // Emptied: deleted. The last one deleted comes back where it was.
    expect(review.setComment("")).toBe("deleted")
    expect(review.count).toBe(1)
    review.toEnd()
    expect(review.restoreComment()).toBe(true)
    expect(review.commentAt()).toMatchObject({ on: "added", line: 2, text: "good: keep it" })
    expect(review.restoreComment()).toBe(false)
    expect(review.deleteComment()).toMatchObject({ text: "good: keep it" })
    expect(review.deleteComment()).toBeNull()
    // On a file's own line: about the file as a whole.
    review.moveFile(1)
    expect(review.setComment("should this be committed?")).toBe("saved")
    expect(review.commentAt()).toEqual({ path: "logo.png", on: "file", line: null, quote: null, text: "should this be committed?" })
    expect(review.commentsOn(0)).toBe(1)
    expect(review.commentsOn(1)).toBe(1)
    expect(review.commentsOn(2)).toBe(0)
  })
})

describe("the message a review becomes", () => {
  test("per comment: the path, the line in the new file or (said so) in the old one, the line quoted, the comment; an overall note above them", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    review.setComment("Why was this a subtraction?\nIs a caller relying on it?")
    review.move(1)
    review.setComment("Good.")
    review.move(2)
    review.setComment("Drop this empty line.")
    review.moveFile(1)
    review.setComment("Should a binary be in this change?")
    review.toEnd()
    review.setComment("Say what the second note is for.")
    review.note = "Close. Two things before this can go in."
    expect(reviewMessage(review)).toBe(
      [
        "Review of the changes in turn 2 (the latest turn): 5 comments on 3 files.",
        "",
        "Overall: Close. Two things before this can go in.",
        "",
        "1. src/add.ts, line 2 of the old file (removed)",
        "   >   return a - b",
        "   Why was this a subtraction?",
        "   Is a caller relying on it?",
        "",
        "2. src/add.ts, line 2 (added)",
        "   >   return a + b",
        "   Good.",
        "",
        "3. src/add.ts, line 4 (unchanged)",
        "   > (an empty line)",
        "   Drop this empty line.",
        "",
        "4. logo.png (the file as a whole)",
        "   Should a binary be in this change?",
        "",
        "5. notes.md, line 2 (added)",
        "   > two",
        "   Say what the second note is for.",
      ].join("\n"),
    )
  })

  test("one comment, no note, an earlier turn; a note of several lines; a very long line is cut and said to be", () => {
    const long = file("min.js", `@@ -0,0 +1 @@\n+${"x".repeat(1000)}\n`, { status: "added" })
    const review = new Review({ turn: 1, latest: false }, [long])
    review.setComment("Do not commit the minified file.")
    expect(reviewMessage(review)).toBe(`Review of the changes in turn 1: 1 comment on 1 file.\n\n1. min.js, line 1 (added)\n   > ${"x".repeat(240)}… (the line is cut here: it has 760 more characters)\n   Do not commit the minified file.`)
    expect(reviewMessage(review, "First.\n\nSecond.").split("\n").slice(0, 7)).toEqual(["Review of the changes in turn 1: 1 comment on 1 file.", "", "Overall:", "   First.", "", "   Second.", ""])
    expect(reviewMessage(new Review({ turn: null, latest: true }, [long]))).toBe("Review of the changes in the latest turn: 0 comments on 0 files.")
  })
})

describe("the screen", () => {
  test("the files, the patch with line numbers and the cursor, the comment under its line, and the count of comments", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    const screen = new ReviewScreen(review)
    review.setComment("why minus?")
    review.move(1)
    const lines = text(screen, 80, 24)
    expect(lines).toHaveLength(24)
    expect(lines.every((line) => Bun.stringWidth(line) <= 80)).toBe(true)
    expect(lines[0]).toBe(`Review of turn 2 · ${COMMENT_MARK} 1 comment · 3 files · +4 -1`)
    expect(lines.slice(1, 5)).toEqual([`▸ src/add.ts · +2 -1  ${COMMENT_MARK} 1`, "  logo.png · new file · binary", "  notes.md · new file · +2 -0", `─ file 1 of 3 ${"─".repeat(66)}`])
    expect(lines.slice(5, 12)).toEqual([
      "   src/add.ts · +2 -1",
      "   @@ -1,4 +1,4 @@",
      "    1  1  export function add(a: number, b: number) {",
      ` ${COMMENT_MARK}  2    -  return a - b`,
      "          ╰ why minus?",
      "▌      2 +  return a + b",
      "    3  3  }",
    ])
    expect(lines.at(-1)).toBe("↑↓ [ ] n p move · c comment · s send · Esc leave")
    expect(text(screen, 120, 24).at(-1)).toBe("↑↓ line · [ ] hunk · n p file · c comment · s send (1) · Esc leave, comments kept")
    review.move(-1)
    expect(text(screen, 120, 24).at(-1)).toBe("↑↓ line · [ ] hunk · n p file · c edit · d delete · s send (1) · Esc leave, comments kept")
    // A file without lines says what it is, under its own line.
    review.moveFile(1)
    const logo = text(screen, 80, 24)
    expect(logo[1]).toBe("  src/add.ts · +2 -1  ◆ 1")
    expect(logo[2]).toBe("▸ logo.png · new file · binary")
    expect(logo.join("\n")).toContain("▌  logo.png · new file · binary\n   binary file: it has no lines to show or comment on; a comment on the file's\n   line above is about the file as a whole")
  })

  test("the cursor's row stays on a small screen, and a long line wraps under its text", () => {
    const wide = file("wide.txt", `@@ -0,0 +1,40 @@\n${Array.from({ length: 40 }, (_, index) => `+line ${index + 1} ${index === 30 ? "word ".repeat(30) : ""}`).join("\n")}\n`, { status: "added" })
    const screen = new ReviewScreen(new Review({ turn: 1, latest: true }, [wide]))
    for (let step = 0; step < 30; step += 1) screen.key(key("down"), "")
    const lines = text(screen, 60, 12)
    expect(lines).toHaveLength(12)
    expect(lines.every((line) => Bun.stringWidth(line) <= 60)).toBe(true)
    const at = lines.findIndex((line) => line.startsWith("▌    31 +line 31"))
    expect(at).toBeGreaterThan(2)
    expect(lines[at + 1]).toMatch(/^▌ {8}word word/)
    // A screenful down and up again, by the rows on the screen.
    screen.key(key("pagedown"), "")
    expect(screen.review.lines[screen.review.cursor]!.newLine).toBeGreaterThan(33)
    screen.key(key("home"), "")
    expect(text(screen, 60, 12)[3]).toBe("▌  wide.txt · new file · +40 -0")
  })

  test("keys: c writes, Enter saves, Esc cancels, d deletes, u brings back, s asks before sending, Esc leaves", () => {
    const review = new Review({ turn: 2, latest: true }, FILES)
    const screen = new ReviewScreen(review)
    expect(screen.key(key("s"), "")).toBe("handled")
    expect(screen.notice).toEqual({ text: "there is no comment to send yet: c writes one on the line under the cursor", tone: "warn" })
    expect(screen.mode).toBe("browse")
    expect(screen.key(key("c"), "")).toBe("handled")
    expect(screen.mode).toBe("comment")
    expect(screen.draft).toBe("")
    // Text is the editor's; Alt-Enter is its new line.
    expect(screen.key(key("x"), "")).toBe("pass")
    expect(screen.key(key("return", { meta: true }), "x")).toBe("pass")
    const writing = screen.frame(80, 24, "why minus?")
    expect(writing.editor).toEqual({ top: 22, left: 2, width: 78, height: 1 })
    const shown = writing.lines.map((line) => line.map((part) => part.text).join(""))
    expect(shown[21]).toStartWith("─ comment on src/add.ts, line 2 of the old file (removed) ─")
    expect(shown[22]).toBe("› ")
    expect(shown[23]).toBe("Enter save · Alt-Enter new line · Esc cancel")
    expect(screen.key(key("return"), "why minus?")).toBe("handled")
    expect(screen.mode).toBe("browse")
    expect(review.commentAt()!.text).toBe("why minus?")
    // Opened again it starts with what is there; Esc leaves it as it was.
    screen.key(key("return"), "")
    expect(screen.draft).toBe("why minus?")
    expect(text(screen, 80, 24, "why")[21]).toStartWith("─ edit the comment on src/add.ts, line 2 of the old file (removed) ─")
    expect(screen.key(key("escape"), "why")).toBe("handled")
    expect(review.commentAt()!.text).toBe("why minus?")
    expect(screen.notice?.text).toBe("the comment is as it was")
    screen.key(key("d"), "")
    expect(review.count).toBe(0)
    expect(screen.notice?.text).toBe("the comment was deleted · u brings it back")
    screen.key(key("d"), "")
    expect(screen.notice?.text).toBe("there is no comment on this line to delete")
    screen.key(key("u"), "")
    expect(review.count).toBe(1)
    // The last look: the message as it will be sent, with the note as it is typed.
    screen.key(key("s"), "")
    expect(screen.mode).toBe("send")
    const last = text(screen, 80, 24, "Close.")
    expect(last[0]).toBe(`Send this review to the agent? · ${COMMENT_MARK} 1 comment on 1 file of turn 2`)
    expect(last.slice(2, 9)).toEqual([" Review of the changes in turn 2 (the latest turn): 1 comment on 1 file.", "", " Overall: Close.", "", " 1. src/add.ts, line 2 of the old file (removed)", "    >   return a - b", "    why minus?"])
    expect(last.at(-1)).toBe("Enter sends it · Alt-Enter new line · Esc back to the review")
    screen.delivery = () => "queues it for after the running turn"
    expect(text(screen, 100, 24).at(-1)).toBe("Enter queues it for after the running turn · Alt-Enter new line · Esc back to the review")
    // Too long for the width, a hint falls back to a shorter form: it is never cut in the middle of a key.
    expect(text(screen, 80, 24).at(-1)).toBe("Enter queues it for after the running turn · Esc back")
    // Esc goes back with the note kept; Enter sends.
    expect(screen.key(key("escape"), "Close.")).toBe("handled")
    expect(screen.mode).toBe("browse")
    expect(review.note).toBe("Close.")
    screen.key(key("s"), "")
    expect(screen.draft).toBe("Close.")
    expect(screen.key(key("return"), "Close. Thanks.")).toBe("send")
    expect(review.note).toBe("Close. Thanks.")
    expect(new ReviewScreen(review).key(key("escape"), "")).toBe("leave")
    expect(new ReviewScreen(review).key(key("q"), "")).toBe("leave")
  })
})

// ---------------------------------------------------------------- in the app

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const scenario = families["Approval and the sandbox"]!.find((item) => item.title.startsWith("A command needs the network"))!
const ALL = stamp(scenario, "ses_script")
const emit = (session: ScriptBackend["session"], events: typeof ALL) => session!.emit(...events.map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never))
const keys = () => mounted!.setup.mockInput
const DIFF: DiffResult = { available: true, scope: "turn", executionId: "exe_1", messageId: null, from: "a".repeat(40), to: "b".repeat(40), files: FILES }

async function command(text: string): Promise<void> {
  await keys().typeText(text)
  // The palette is open while a command is typed: Esc first, so Enter runs what was typed.
  keys().pressEscape()
  await Bun.sleep(80)
  keys().pressEnter()
  await mounted!.settle()
}

async function opened(result: DiffResult = DIFF, events = ALL) {
  const backend = new ScriptBackend()
  mounted = await mount({ width: 100, height: 30, backend })
  const session = backend.session!
  const asked: unknown[] = []
  session.diff = async (params) => {
    asked.push(params)
    return result
  }
  emit(session, events)
  await mounted.settle()
  return { backend, session, asked, app: mounted.app }
}

describe("/review in the app", () => {
  test("comments on a removed and an added line, the last look, and the one message that is sent", async () => {
    const { backend, asked, app } = await opened()
    const executionId = (ALL.find((item) => item.type === "execution.started") as Extract<(typeof ALL)[number], { type: "execution.started" }>).data.executionId
    await command("/review")
    expect(app.review.open).toBe(true)
    expect(asked).toEqual([{ executionId }])
    let frame = await mounted!.frame()
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 100)).toBe(true)
    expect(frame).toContain("Review of turn 1 · no comments yet · 3 files · +4 -1")
    expect(frame).toContain("▌   2    -  return a - b")
    // The removed line: c, the comment on two lines (a backslash at the end goes on), Enter.
    keys().pressKey("c")
    await mounted!.settle()
    await keys().typeText("Why was this a subtraction?\\")
    keys().pressEnter()
    await keys().typeText("Is a caller relying on it?")
    await mounted!.settle()
    frame = await mounted!.frame()
    expect(frame).toContain("─ comment on src/add.ts, line 2 of the old file (removed) ─")
    expect(frame).toContain("› Why was this a subtraction?\n  Is a caller relying on it?\nEnter save · Alt-Enter new line · Esc cancel")
    keys().pressEnter()
    await mounted!.settle()
    // The added line under it.
    keys().pressArrow("down")
    keys().pressKey("c")
    await mounted!.settle()
    await keys().typeText("Good.")
    keys().pressEnter()
    await mounted!.settle()
    frame = await mounted!.frame()
    expect(frame).toContain(`Review of turn 1 · ${COMMENT_MARK} 2 comments · 3 files · +4 -1`)
    expect(frame).toContain(` ${COMMENT_MARK}  2    -  return a - b\n          ╰ Why was this a subtraction?\n            Is a caller relying on it?\n▌${COMMENT_MARK}     2 +  return a + b\n▌         ╰ Good.`)
    expect(frame).toMatchSnapshot()
    // s: the message for a last look, with a note typed above the comments; Enter sends.
    keys().pressKey("s")
    await mounted!.settle()
    await keys().typeText("Nearly there.")
    await mounted!.settle()
    frame = await mounted!.frame()
    expect(frame).toContain(`Send this review to the agent? · ${COMMENT_MARK} 2 comments on 1 file of turn 1`)
    expect(frame).toContain(" Overall: Nearly there.\n\n 1. src/add.ts, line 2 of the old file (removed)\n    >   return a - b\n    Why was this a subtraction?\n    Is a caller relying on it?\n\n 2. src/add.ts, line 2 (added)")
    expect(frame).toContain("› Nearly there.\nEnter sends it · Alt-Enter new line · Esc back to the review")
    expect(frame).toMatchSnapshot()
    keys().pressEnter()
    await mounted!.settle()
    expect(app.review.open).toBe(false)
    expect(backend.sent).toEqual([
      {
        delivery: "steer",
        text: [
          "Review of the changes in turn 1 (the latest turn): 2 comments on 1 file.",
          "",
          "Overall: Nearly there.",
          "",
          "1. src/add.ts, line 2 of the old file (removed)",
          "   >   return a - b",
          "   Why was this a subtraction?",
          "   Is a caller relying on it?",
          "",
          "2. src/add.ts, line 2 (added)",
          "   >   return a + b",
          "   Good.",
        ].join("\n"),
      },
    ])
    // The input has the keys again, and what was sent is not kept as a draft.
    expect(app.input.focused).toBe(true)
    await command("/review")
    expect(await mounted!.frame()).toContain("Review of turn 1 · no comments yet")
  })

  test("leaving without sending keeps the comments for the turn, and says so; /review opens them again", async () => {
    const { backend, app } = await opened()
    await command("/review")
    keys().pressKey("]")
    keys().pressKey("c")
    await mounted!.settle()
    // A paste goes to the comment, not to the input under the view.
    await keys().pasteBracketedText("one more what?")
    keys().pressEnter()
    await mounted!.settle()
    expect(await mounted!.frame()).toContain(`▌${COMMENT_MARK}    21 +// one more\n▌         ╰ one more what?`)
    keys().pressEscape()
    await Bun.sleep(80)
    await mounted!.settle()
    expect(app.review.open).toBe(false)
    expect(backend.sent).toEqual([])
    expect(app.input.plainText).toBe("")
    expect(app.conversation.text().replace(/\s+/g, " ")).toContain("· the review of turn 1 was closed without sending: its comment is kept until this session is closed · /review opens it again")
    await command("/review")
    const frame = await mounted!.frame()
    expect(frame).toContain(`Review of turn 1 · ${COMMENT_MARK} 1 comment`)
    expect(frame).toContain("╰ one more what?")
    // Deleted, the review has nothing to keep and leaving says nothing more.
    keys().pressKey("d")
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("the comment was deleted · u brings it back")
    keys().pressKey("q")
    await mounted!.settle()
    expect(app.conversation.text().match(/closed without sending/g)).toHaveLength(1)
  })

  test("a turn that changed no file, and a diff that cannot be had, are said instead of an empty view", async () => {
    const { app } = await opened({ ...DIFF, files: [] })
    await command("/review")
    expect(app.review.open).toBe(false)
    expect(app.conversation.text()).toContain("· nothing to review: turn 1 changed no file")
    await mounted!.dispose()
    const second = await opened({ available: false, reason: "no_snapshots", message: "no snapshot was recorded around this turn" })
    await command("/review")
    expect(second.app.review.open).toBe(false)
    expect(second.app.conversation.text().replace(/\s+/g, " ")).toContain("· no review of turn 1: its diff is not available: no snapshot was recorded around this turn")
  })

  test("r in the diff reader opens the review of that turn; while the agent works the message is queued or steered as a typed one is", async () => {
    // The turn is still running: there is no ending row, and the engine's latest turn is reviewed.
    const running = ALL.slice(0, ALL.findIndex((item) => item.type === "approval.requested"))
    const { backend, asked, app } = await opened({ ...DIFF, executionId: "exe_before" }, running)
    await command("/diff")
    expect(app.pager.open).toBe(true)
    expect(await mounted!.frame()).toContain("↑↓ PgUp PgDn scroll · n p file · r review and comment · Esc close")
    keys().pressKey("r")
    await mounted!.settle()
    expect(app.pager.open).toBe(false)
    expect(app.review.open).toBe(true)
    expect(asked).toEqual([{}, { executionId: "exe_before" }])
    expect(await mounted!.frame()).toContain("Review of the latest turn · no comments yet")
    keys().pressKey("c")
    await mounted!.settle()
    await keys().typeText("x")
    keys().pressEnter()
    keys().pressKey("s")
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("Enter sends it into the running turn (steer) · Alt-Enter new line · Esc back to the review")
    keys().pressEnter()
    await mounted!.settle()
    expect(backend.sent).toHaveLength(1)
    expect(backend.sent[0]!.delivery).toBe("steer")
    expect(backend.sent[0]!.text).toStartWith("Review of the changes in the latest turn: 1 comment on 1 file.\n\n1. src/add.ts, line 2 of the old file (removed)")
    // Queue mode (Ctrl-T): the next review is held until the turn ends.
    keys().pressKey("t", { ctrl: true })
    await command("/review")
    keys().pressKey("c")
    await mounted!.settle()
    await keys().typeText("y")
    keys().pressEnter()
    keys().pressKey("s")
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("Enter queues it for after the running turn")
    keys().pressEnter()
    await mounted!.settle()
    expect(backend.sent.map((item) => item.delivery)).toEqual(["steer", "queue"])
  })
})

describe("the turn /review is about", () => {
  test("the selected ending row's turn, the turn a selected row belongs to, or the latest that ended", () => {
    const row = (kind: string, more: object = {}) => ({ kind, ...more }) as never
    const rows = [row("user"), row("tool"), row("outcome", { executionId: "exe_1", turn: 1 }), row("user"), row("tool"), row("outcome", { executionId: "exe_2", turn: 2 }), row("user"), row("tool")]
    expect(reviewTarget(rows, null)).toEqual({ executionId: "exe_2", turn: 2, latest: true })
    expect(reviewTarget(rows, rows[2]!)).toEqual({ executionId: "exe_1", turn: 1, latest: false })
    expect(reviewTarget(rows, rows[1]!)).toEqual({ executionId: "exe_1", turn: 1, latest: false })
    // A row of the turn still running: the latest that ended.
    expect(reviewTarget(rows, rows[7]!)).toEqual({ executionId: "exe_2", turn: 2, latest: true })
    expect(reviewTarget(rows, null, "exe_1")).toEqual({ executionId: "exe_1", turn: 1, latest: false })
    expect(reviewTarget([], null)).toEqual({ executionId: null, turn: null, latest: true })
    expect(reviewTarget([], null, "exe_9")).toEqual({ executionId: "exe_9", turn: null, latest: true })
  })
})
