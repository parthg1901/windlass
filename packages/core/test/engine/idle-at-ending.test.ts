/**
 * A session is idle by the time a reader is shown its turn's ending: a
 * client that sees `execution.succeeded` and asks for an undo at once is
 * not refused as busy. The ending is durable when it is written and is
 * delivered once the run that wrote it has let go, however the loop got
 * there: with no hooks and no language server, with both offered and none
 * configured, and with a stop hook, an after hook and a language server
 * that all ran in the turn.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { RevertResult } from "../../src/engine/engine.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { fixture, waitFor } from "../lsp/helpers.ts"
import { measured } from "../scenarios/script.ts"
import { FakeWorkspace, Harness, type HarnessOptions, failed, removeHarnessDirectories, untilAbort } from "./harness.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const BEFORE = "one\n"
const AFTER = "one\ntwo\n"

/** A real directory with the file the turn edits, for the tests in which a language server reads it. */
function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-engine-idle-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  mkdirSync(join(cwd, "src"), { recursive: true })
  writeFileSync(join(cwd, "src", "a.txt"), BEFORE)
  return cwd
}

type Reader = "a stream reader" | "a listener"

interface Seen {
  /** What `revert()` answered when it was called the moment the ending was seen. */
  readonly result: RevertResult
  /** Whether the session said it was working at that moment. */
  readonly working: boolean
}

/** Calls `revert()` as soon as `reader` is shown an event of type `ending`, in the very turn of the event loop it is shown in. */
function revertAt(h: Harness, reader: Reader, ending: EngineEvent["type"]): Promise<Seen> {
  const session = h.session
  return new Promise<Seen>((resolve, reject) => {
    const act = (item: EngineEvent) => {
      if (item.type !== ending) return false
      const working = session.working
      session.revert().then((result) => resolve({ result, working }), reject)
      return true
    }
    if (reader === "a listener") {
      const stop = session.subscribe((item) => {
        if (act(item)) stop()
      })
      return
    }
    void (async () => {
      for await (const item of session.events) if (act(item)) return
    })().catch(reject)
  })
}

/** One turn that reads `src/a.txt` and rewrites it, in a workspace the engine snapshots. */
function editing(options: HarnessOptions, cwd?: string) {
  const h = new Harness({ workspace: new FakeWorkspace({ "src/a.txt": BEFORE }), ...(cwd === undefined ? {} : { cwd }), ...options })
  h.provider.enqueue([call("read", { path: "src/a.txt" }), U], [call("write", { path: "src/a.txt", content: AFTER }), U], answer("Added the line."))
  h.tools.on("read", BEFORE)
  h.tools.on("write", async (input) => {
    // A language server that is configured has started on the read; the write waits for it, as a model's next step would.
    if (cwd !== undefined) {
      await waitFor(() => h.session.lsp()?.servers.some((server) => server.state === "ready") ?? false, 15_000, "the language server to start")
      writeFileSync(join(cwd, String(input.path)), String(input.content))
    }
    h.workspace!.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}.`
  })
  return h
}

const CASES: readonly { readonly name: string; readonly make: () => { readonly h: Harness; readonly ran: () => readonly string[]; readonly cwd?: string } }[] = [
  { name: "no hooks and no language server", make: () => ({ h: editing({}), ran: () => [] }) },
  { name: "hooks and language servers offered, none configured", make: () => ({ h: editing({ userConfig: { verify: { mode: "off" } }, hooks: {}, lsp: {} }), ran: () => [] }) },
  {
    name: "an after hook, a stop hook and a language server that all ran",
    make: () => {
      const cwd = project()
      const scripted = scriptedRunner({ format: exited(0), tidy: exited(0) })
      const h = editing(
        {
          userConfig: {
            verify: { mode: "off" },
            hooks: { afterTool: [{ name: "format", tools: ["write"], command: "format" }], stop: [{ name: "tidy", command: "tidy" }] },
            lsp: { waitMs: 5000, servers: { fixture: fixture() } },
          },
          hooks: { runner: scripted.runner },
          lsp: { graceMs: 300, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 } },
        },
        cwd,
      )
      return { h, ran: () => scripted.requests.map((request) => request.hook.name), cwd }
    },
  },
]

describe("a reader that reverts the moment it sees a turn's ending", () => {
  for (const { name, make } of CASES)
    for (const reader of ["a stream reader", "a listener"] as const)
      test(`${reader}, with ${name}: the session is idle, and the turn is undone`, async () => {
        const { h, ran, cwd } = make()
        try {
          h.create()
          const seen = revertAt(h, reader, "execution.succeeded")
          h.session.send("Add a line.")
          const { result, working } = await seen
          expect(working).toBe(false)
          expect(result).toMatchObject({ kind: "reverted", restore: { changed: 1 } })
          expect(h.workspace!.files.get("src/a.txt")).toBe(BEFORE)
          expect(h.log().slice(-5).map((item) => item.type)).toEqual(["execution.succeeded", "snapshot.taken", "revert.started", "snapshot.taken", "history.reverted"])
          // The hooks and the server of the configured case did run in the turn that was undone.
          if (cwd !== undefined) {
            expect(ran()).toEqual(["format", "tidy"])
            expect(h.log().find((item) => item.type === "tool.settled" && item.data.diagnostics !== undefined)).toBeDefined()
            expect(readFileSync(join(cwd, "src", "a.txt"), "utf8")).toBe(AFTER)
          }
          await h.settled()
          h.verify()
        } finally {
          await h.dispose()
        }
      }, 60_000)

  test("the ending of a turn the user stopped: its reader finds the session idle too", async () => {
    const h = new Harness({ workspace: new FakeWorkspace({ "src/a.txt": BEFORE }) })
    try {
      h.provider.enqueue([call("shell", { command: "sleep 600" }), U])
      h.tools.on("shell", async (_, context) => (await untilAbort(context.signal), failed("[Interrupted by the user.]")))
      h.create()
      const seen = revertAt(h, "a stream reader", "execution.interrupted")
      h.session.send("Wait.")
      await h.seen((item) => item.type === "tool.started")
      h.session.interrupt()
      const { result, working } = await seen
      expect(working).toBe(false)
      expect(result.kind).toBe("reverted")
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("what is published after the ending keeps its order, and input sent from the reader starts the next turn", async () => {
    const h = new Harness()
    try {
      h.provider.enqueue(answer("One."), answer("Two."))
      h.create()
      const types: string[] = []
      let sent = false
      h.session.subscribe((item) => {
        if (!("seq" in item)) return
        types.push(item.type)
        if (item.type === "execution.succeeded" && !sent) {
          sent = true
          // Idle here: the prompt starts an execution of its own at once, it does not wait for a drain to return.
          expect(h.session.working).toBe(false)
          h.session.send("Again.")
          expect(h.session.working).toBe(true)
        }
      })
      h.session.send("Once.")
      await h.seen((item) => item.type === "execution.succeeded")
      await h.settled()
      expect(types).toEqual(h.log().map((item) => item.type).slice(1))
      expect(types.filter((type) => type === "execution.succeeded")).toHaveLength(2)
      h.verify()
    } finally {
      await h.dispose()
    }
  })
})

