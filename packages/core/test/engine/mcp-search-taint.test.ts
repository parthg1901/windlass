/**
 * A catalogue search is not a taint source.
 *
 * What a server declares about its tools (names, descriptions, input
 * schemas) is catalogue-grade text: the appended catalogue carries the same
 * names and one-line descriptions and is deliberately not a source
 * (docs/architecture.md, "MCP servers": "*Taint.*"), and a search that shows
 * them, with or without `includeSchema`, is not one either
 * (`mcp/bridge.ts`, `mcpSearchTool.execute`). So a one-prompt run in mode
 * `full` can search for a tool of a server left at the default
 * `untrusted: true` and call it: the call is decided before anything
 * untrusted is in the conversation.
 *
 * A search stays a source for the text the catalogue never carries: the
 * server's notes (`instructions`) and an error or stderr text in a status
 * line. A call's result is a source as always.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { McpSetup } from "../../src/engine/mcp.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "./harness.ts"
import { fixtureServer } from "../mcp/helpers.ts"
import { measured } from "../scenarios/script.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId: string) => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const QUICK: McpSetup = { startWaitMs: 8000, probeMs: 300, graceMs: 500, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 }, dropAfterMs: 200 }
const sandbox: CommandSandbox = {
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
}
const approval = (more: Partial<ApprovalSetup> = {}): ApprovalSetup => ({ sandbox, secrets: [], home: "/home/user", ...more })
const of = <T extends StoredEvent["type"]>(h: Harness, type: T) => h.log().filter((item) => item.type === type) as unknown as StoredEvent<T>[]

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-mcp-search-")))
  made.push(root)
  const cwd = join(root, "repo")
  mkdirSync(join(cwd, ".git"), { recursive: true })
  return cwd
}

/** A one-shot run in mode `full` (nobody present) against one server at the default `untrusted: true`. */
async function oneShot(search: Json, run: (h: Harness) => void) {
  const h = new Harness({
    cwd: project(),
    approval: approval({ user: { mode: "full" } }),
    mcp: QUICK,
    userConfig: { mcp: { servers: { fx: fixtureServer(["--only", "echo"]) } } },
  })
  try {
    h.provider.enqueue(
      [call("mcp_search", search, "call_0"), U],
      [call("mcp_call", { server: "fx", tool: "echo", arguments: { text: "hello" } }, "call_1"), U],
      answer("Done."),
    )
    h.create().send("Echo hello with the MCP server.")
    await h.settled()
    run(h)
  } finally {
    await h.dispose()
  }
}

describe("a catalogue search does not taint the session", () => {
  test("a search without schemas brings in nothing the catalogue does not carry: no taint, and full runs the call", () =>
    oneShot({ query: "echo" }, (h) => {
      const [search, called] = of(h, "tool.settled").map((item) => item.data)
      expect(search).toMatchObject({ outcome: "success", display: { mcp: { kind: "search", servers: ["fx"] } } })
      // The search's result is no taint source, so the call that follows is decided in an untainted session.
      expect(of(h, "approval.denied")).toEqual([])
      expect(called).toMatchObject({ outcome: "success", display: { mcp: { kind: "call", untrusted: true, outcome: "result" } } })
      // The session is tainted by what the server's tool returned, not by the search.
      expect(of(h, "taint.noticed").map((item) => item.data.source)).toEqual([expect.objectContaining({ kind: "mcp-tool", tool: "fx/echo" })])
    }))

  test("a search with schemas is the tool's declaration too: no taint before the call", () =>
    oneShot({ query: "echo", includeSchema: true }, (h) => {
      expect(of(h, "approval.denied")).toEqual([])
      expect(of(h, "taint.noticed")[0]?.data.source).toMatchObject({ tool: "fx/echo" })
    }))

  // A server's notes are text the catalogue never carries.
  test("a search scoped to the server shows its notes, which stay a source", () =>
    oneShot({ query: "echo", server: "fx" }, (h) => {
      expect(of(h, "tool.settled")[0]!.data.output).toContain("Notes from the server fx:")
      expect(of(h, "taint.noticed")[0]?.data.source).toMatchObject({ kind: "mcp-tool", tool: "mcp_search" })
      expect(of(h, "approval.denied")[0]?.data).toMatchObject({ reason: "unattended" })
    }))
})
