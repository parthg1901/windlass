/**
 * The review of a turn's diff in a real pseudo-terminal (tmux), against the
 * real server with a scripted model that edits two files: the review is
 * opened, a removed and an added line are commented on, the review is sent,
 * and the request the model then received is read back from the session's
 * stored log (through the trace exporter). No model requests are made.
 */
import { afterAll, afterEach, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "@windlass/core"
import { SCRIPT_ENV } from "../../acp/src/scripted.ts"
import { COMMENT_MARK } from "../src/review.ts"
import { Tmux, killServer } from "./tmux.ts"
import { E2E_TIMEOUT_MS } from "@windlass/core/testing"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

const MAIN = new URL("../../cli/src/main.ts", import.meta.url).pathname
const EXPORT = new URL("../../../scripts/export-trace.ts", import.meta.url).pathname
const READY = "● ready"
const SOCKET = `wl-review-test-${process.pid}`
const open: Tmux[] = []
const dirs: string[] = []

afterEach(() => {
  for (const term of open.splice(0)) term.kill()
})
afterAll(() => {
  killServer(SOCKET)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The conversation column of a frame: the panel on the right is left out. */
const conversation = (frame: string) =>
  frame
    .split("\n")
    .map((line) => line.split("│")[0]!.trimEnd())
    .join("\n")

const MESSAGE = [
  "Review of the changes in turn 1 (the latest turn): 2 comments on 2 files.",
  "",
  "Overall: Two small things.",
  "",
  "1. README.md, line 1 of the old file (removed)",
  "   > # demo",
  "   Keep the short title.",
  "",
  "2. notes.md, line 1 (added)",
  "   > first note",
  "   Say what this note is for.",
].join("\n")

test("a turn that edits two files is reviewed: a comment on a removed and on an added line, sent as one message the model receives", async () => {
  const root = mkdtempSync(join(tmpdir(), "wl-review-e2e-"))
  dirs.push(root)
  const cwd = join(root, "work")
  for (const dir of [cwd, join(root, "xdg"), join(root, "config")]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(cwd, "README.md"), "# demo\n\nA small project.\n")
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]]) Bun.spawnSync(["git", ...args], { cwd })
  const script = join(root, "script.json")
  // A call is in the exported trace only when its response reported usage.
  const usage = { type: "usage", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 20 }
  writeFileSync(
    script,
    JSON.stringify({
      responses: [
        [
          { type: "tool_call", callId: "c1", name: "write", input: { path: "README.md", content: "# demo project\n\nA small project.\n" } },
          { type: "tool_call", callId: "c2", name: "write", input: { path: "notes.md", content: "first note\nsecond note\n" } },
          usage,
        ],
        [{ type: "text", text: "Both files are written." }, usage],
        [{ type: "text", text: "I read your review and will fix both." }, usage],
      ],
    }),
  )
  const data = join(root, "xdg")
  const term = await Tmux.start({ width: 100, height: 30, socket: SOCKET, command: [process.execPath, MAIN, "tui", "--cwd", cwd], env: { NO_COLOR: "", XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(root, "config"), [SCRIPT_ENV]: script } })
  open.push(term)
  await term.waitFor(READY, { timeoutMs: 30_000 })
  term.type("edit two files")
  term.keys("Enter")
  await term.waitFor("○ done", { timeoutMs: 30_000 })
  await term.waitFor(READY)

  // /review: the latest turn, the cursor on its first changed line.
  term.type("/review")
  await term.waitFor(/\/review\s+review the selected turn/)
  term.keys("Enter")
  let frame = await term.waitFor("Review of turn 1 · no comments yet · 2 files · +3 -1")
  expect(frame).toContain("▸ README.md · +1 -1")
  expect(frame).toContain("  notes.md · new file · +2 -0")
  expect(frame).toContain("▌  1   -# demo")
  expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 100)).toBe(true)

  // A comment on the removed line.
  term.type("c")
  await term.waitFor("─ comment on README.md, line 1 of the old file (removed) ─")
  term.type("Keep the short title.")
  term.keys("Enter")
  await term.waitFor(`Review of turn 1 · ${COMMENT_MARK} 1 comment`)

  // The next hunk is the new file's: a comment on its first added line.
  term.type("]")
  await term.waitFor("▌    1 +first note")
  term.type("c")
  await term.waitFor("─ comment on notes.md, line 1 (added) ─")
  term.type("Say what this note is for.")
  term.keys("Enter")
  frame = await term.waitFor(`Review of turn 1 · ${COMMENT_MARK} 2 comments`)
  expect(frame).toContain(` ${COMMENT_MARK} 1   -# demo\n        ╰ Keep the short title.`)
  expect(frame).toContain(`▌${COMMENT_MARK}   1 +first note\n▌       ╰ Say what this note is for.`)
  expect(frame).toContain(`  README.md · +1 -1  ${COMMENT_MARK} 1`)
  expect(frame).toContain(`▸ notes.md · new file · +2 -0  ${COMMENT_MARK} 1`)

  // The last look, with a note; Enter sends.
  term.type("s")
  await term.waitFor("Send this review to the agent?")
  term.type("Two small things.")
  frame = await term.waitFor("› Two small things.")
  expect(frame).toContain(
    MESSAGE.split("\n")
      .map((line) => ` ${line}`.trimEnd())
      .join("\n"),
  )
  expect(frame).toContain("Enter sends it · Alt-Enter new line · Esc back to the review")
  term.keys("Enter")

  // One message in the conversation, as it was shown; the agent answers it.
  frame = await term.waitFor((shown) => shown.includes("I read your review and will fix both.") && shown.includes(READY) && shown.includes("turn 2"), { timeoutMs: 30_000 })
  expect(conversation(frame)).toContain("  › Review of the changes in turn 1 (the latest turn): 2\n    comments on 2 files.\n\n    Overall: Two small things.\n\n    1. README.md, line 1 of the old file (removed)\n       > # demo\n       Keep the short title.\n\n    2. notes.md, line 1 (added)\n       > first note\n       Say what this note is for.")
  term.keys("C-d")
  expect(await term.exited({ timeoutMs: 20_000 })).toBe(0)

  // What the model received: the third request ends with the review as the user's message, and it was sent once.
  const dataDir = join(data, brand.directory)
  const listed = Bun.spawnSync([process.execPath, EXPORT, "--list", "--data-dir", dataDir]).stdout.toString()
  const sessionId = /^(ses_\w+)/m.exec(listed)?.[1]
  expect(sessionId).toBeDefined()
  const exported = Bun.spawnSync([process.execPath, EXPORT, sessionId!, "--data-dir", dataDir])
  expect(exported.exitCode).toBe(0)
  const calls = exported.stdout
    .toString()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { request: { blocks: { kind: string; key: string; content: { content?: { text?: string }[] } }[] } })
  expect(calls).toHaveLength(3)
  const users = calls[2]!.request.blocks.filter((block) => block.kind === "message" && block.key === "user").map((block) => block.content.content?.[0]?.text)
  expect(users.at(-1)).toBe(MESSAGE)
  expect(users.filter((text) => text?.startsWith("Review of the changes"))).toHaveLength(1)
}, 120_000)
