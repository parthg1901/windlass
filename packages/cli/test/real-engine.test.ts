/**
 * The real engine behind the CLI's interface, with a scripted provider and a
 * temporary data directory: a turn, `/undo` and `/redo` through the input
 * editor, and what `--model` is checked against. No network, no sign-in.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EngineError, type StoredEvent } from "@light-harness/core"
import { FakeProvider, script } from "@light-harness/core/testing"
import { offerSession } from "../src/commands.ts"
import { type EngineEvent, EngineUnavailable, type Session } from "../src/engine.ts"
import { createRealEngine } from "../src/real-engine.ts"
import { PrettyRenderer } from "../src/renderer.ts"
import { Screen } from "../src/terminal.ts"
import { VirtualTerminal } from "./vt.ts"

const scratch: string[] = []
afterAll(() => {
  offerSession(null)
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

function place() {
  const root = mkdtempSync(join(tmpdir(), "lh-cli-real-"))
  scratch.push(root)
  const workspace = join(root, "project")
  mkdirSync(workspace)
  writeFileSync(join(workspace, "notes.md"), "# Notes\n")
  return { root, workspace }
}

const open = (workspace: string, model: string | null = null) => ({ session: { kind: "new" as const }, cwd: workspace, model, effort: null, maxSteps: null })

/** Reads the session's events into the renderer, as the CLI does. `turnEnded` resolves when a turn has ended. */
function follow(session: Session, renderer: PrettyRenderer, seen: EngineEvent[]) {
  let ended = () => {}
  const turnEnded = new Promise<void>((resolve) => {
    ended = resolve
  })
  const reading = (async () => {
    // One consumer for the whole stream: leaving the loop early would end it.
    for await (const item of session.events) {
      seen.push(item)
      renderer.event(item)
      if (item.type === "execution.succeeded" || item.type === "execution.failed") ended()
    }
  })()
  return { turnEnded, reading }
}

describe("the real engine", () => {
  test("a turn that edits a file is undone and redone from the input editor", async () => {
    const { root, workspace } = place()
    const provider = new FakeProvider([[script.toolCall("call_1", "write", { path: "notes.md", content: "# Notes\n\n- reviewed\n" })], [script.text("Added the line.")]])
    const engine = createRealEngine({ dataDir: join(root, "data"), provider, engine: { loadConfig: null, discover: () => [], log: () => {} } })
    const session = await engine.open(open(workspace))
    const vt = new VirtualTerminal(100)
    const screen = new Screen({ write: (text) => vt.write(text), columns: () => 100, color: false })
    const renderer = new PrettyRenderer({ write: (text) => screen.write(text), color: false, columns: () => 100, live: false, showReasoning: false, echoPrompts: true })
    const seen: EngineEvent[] = []
    const durable = () => seen.filter((item): item is StoredEvent => "seq" in item).map((item) => item.type)
    try {
      screen.show("› ")
      const { turnEnded, reading } = follow(session, renderer, seen)
      await session.send("Add a line to the notes.")
      await turnEnded
      expect(readFileSync(join(workspace, "notes.md"), "utf8")).toContain("reviewed")
      // The files the turn changed are listed right before its outcome.
      expect(vt.text).toContain("· changed 1 file: notes.md\n\n✓ done · no checks configured")

      // A command is over, or has asked its question and waits for the answer.
      const settle = async () => {
        await Promise.race([screen.commandsSettled(), new Promise((resolve) => setTimeout(resolve, 400))])
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const submitted: string[] = []
      const type = (data: string) => screen.input(data, (action) => submitted.push(action.kind))

      type("/undo\r")
      await settle()
      expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("# Notes\n")
      expect(durable().slice(-4)).toEqual(["snapshot.taken", "revert.started", "snapshot.taken", "history.reverted"])
      expect(vt.text).toContain("↶ going back to before your last message · 3 messages\n  changed back: notes.md")
      expect(vt.text).toContain("↶ went back · 1 file restored · /redo brings it back")

      // The user edits the file by hand; /redo would overwrite that, so it asks first.
      writeFileSync(join(workspace, "notes.md"), "# Notes\n\nmine\n")
      type("/redo\r")
      await settle()
      expect(vt.text.split("\n").at(-1)).toBe("overwrite them? [y]es · [k]eep mine · [N]o ›")
      expect(vt.text).toContain("you edited 1 file by hand since then: notes.md")
      expect(vt.text).toContain("overwriting them cannot be taken back")
      type("n\r")
      await settle()
      expect(readFileSync(join(workspace, "notes.md"), "utf8")).toBe("# Notes\n\nmine\n")
      type("/redo\r")
      await settle()
      type("y\r")
      await settle()
      expect(readFileSync(join(workspace, "notes.md"), "utf8")).toContain("reviewed")
      expect(vt.text).toContain("↷ brought back · 1 file restored")
      expect(durable().at(-1)).toBe("history.restored")
      // None of it reached the turn loop as input.
      expect(submitted).toEqual([])
      await session.close()
      await reading
    } finally {
      await session.close()
    }
  })

  test("a model named on the command line is checked when the session is opened, and the error names the valid ones", async () => {
    const { root, workspace } = place()
    const listed = { listModels: async () => ["gpt-6-luna", "gpt-6.1-sol"] }
    const engine = createRealEngine({ dataDir: join(root, "data"), provider: new FakeProvider(), engine: { loadConfig: null, snapshots: null, log: () => {}, ...listed } })
    const refused = await engine.open(open(workspace, "gpt-6-lunar")).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(EngineUnavailable)
    expect(refused).not.toBeInstanceOf(EngineError)
    expect((refused as Error).message).toBe("model gpt-6-lunar is not available; choose one of: gpt-6-luna, gpt-6.1-sol")
    // A valid one opens, and without --model nothing is asked of the listing.
    const session = await engine.open(open(workspace, "gpt-6-luna"))
    await session.close()
  })
})
