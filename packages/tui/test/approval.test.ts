/**
 * Approvals and the safety states in the real `App` at fixed sizes: the
 * approval dock (what it shows, keyboard answers, a note, Ctrl-C, a
 * subagent's label, and that it never takes what the user is typing), the
 * waiting state, denied and declined calls, the sandbox marker, the taint
 * notice and the confirmation of `/clear-taint`, the approval mode picker,
 * and the per-file diff view. Events come from the engine's own approval
 * scenario (`networkEscalation`), played through a script backend.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { ApprovalAsk } from "@light-harness/acp/client"
import type { DiffResult } from "@light-harness/acp/extensions"
import type { StoredEvent } from "@light-harness/core"
import { families } from "@light-harness/core/testing/scenarios"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import { type Mounted, ScriptBackend, mount, stamp } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const networkEscalation = families["Approval and the sandbox"]!.find((scenario) => scenario.title.startsWith("A command needs the network"))!
const ALL = stamp(networkEscalation, "ses_script")
/** The scenario up to (and with) its first question: a command ran in the sandbox, then curl asks for the network. */
const UNTIL_QUESTION = ALL.slice(0, ALL.findIndex((item) => item.type === "approval.requested") + 1)
const QUESTION = UNTIL_QUESTION.at(-1) as StoredEvent<"approval.requested">

function askOf(item: StoredEvent<"approval.requested">, subagent: string | null = null): ApprovalAsk {
  const data = item.data
  return { sessionId: "ses_script", toolCallId: `${data.messageId}/${data.callId}`, messageId: data.messageId, callId: data.callId, question: data.question, needs: data.needs, then: data.then, subagent, subagentSessionId: subagent === null ? null : "ses_child" }
}

async function asked(options: { width?: number; height?: number; typing?: string; subagent?: string | null } = {}) {
  const backend = new ScriptBackend()
  mounted = await mount({ width: options.width ?? 100, height: options.height ?? 30, backend })
  const session = backend.session!
  session.emit(...UNTIL_QUESTION.map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never))
  await mounted.settle()
  if (options.typing !== undefined) await mounted.setup.mockInput.typeText(options.typing)
  // Long enough after the last key for the dock to take the focus by itself, when nobody is typing.
  mounted.clock.now += options.typing === undefined ? QUIET_MS + 10 : 10
  const controller = new AbortController()
  const answer = backend.onApproval(askOf(QUESTION, options.subagent ?? null), controller.signal)
  await mounted.settle()
  return { backend, session, answer, controller, mounted }
}

const keys = () => mounted!.setup.mockInput
const arm = () => {
  mounted!.clock.now += ARMING_MS + 10
}

describe("the approval dock", () => {
  for (const [width, height] of [
    [100, 30],
    [60, 20],
    [200, 50],
  ] as const)
    test(`shows the tool, the command, why, how it runs, and each choice with what it remembers (${width}x${height})`, async () => {
      await asked({ width, height })
      const frame = await mounted!.frame()
      const lines = frame.split("\n")
      expect(lines).toHaveLength(height)
      expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBe(true)
      expect(frame).toContain("? Allow network access for this command?")
      expect(frame).toContain("shell  curl -s https://example.com/notes")
      expect(frame).toContain("why: network access for this command")
      if (height >= 30) expect(frame).toContain("runs: in the sandbox ⊡ · with network access")
      expect(frame).toContain("[a] Allow once")
      expect(frame).toMatch(/\[s\] Allow for this session +remembers network for/)
      expect(frame).toContain("[n] Don't allow")
      expect(frame).toContain("[m] Don't allow, and tell the agent why…")
      // The waiting state, not "working".
      expect(frame).toMatch(/\? waiting for your answer · shell curl -s https:\/\/example\.c/)
      expect(frame).toMatch(/\? shell curl -s https:\/\/exam\S* · waiting for your approval/)
      if (width === 100) expect(frame).toMatchSnapshot()
    })

  test("answered by keyboard alone: a letter picks, after the dock is armed", async () => {
    const { answer } = await asked()
    await keys().typeText("a")
    await mounted!.settle()
    // A key in the first moments after the dock opened was on its way to the input: it is the user's text.
    expect(mounted!.app.input.plainText).toBe("a")
    await mounted!.setup.mockInput.pressBackspace()
    keys().pressTab()
    arm()
    await keys().typeText("s")
    expect(await answer).toEqual({ choice: "session" })
  })

  test("Up, Down and Enter choose too", async () => {
    const { answer } = await asked()
    arm()
    // Network access is never remembered for the project: the question offers once, session and no.
    expect(await mounted!.frame()).not.toContain("[p]")
    keys().pressArrow("down")
    await mounted!.settle()
    keys().pressArrow("down")
    await mounted!.settle()
    keys().pressArrow("up")
    await mounted!.settle()
    keys().pressEnter()
    expect(await answer).toEqual({ choice: "session" })
  })

  test("declining with a note: m opens the note, Enter sends it with the refusal", async () => {
    const { answer } = await asked()
    arm()
    await keys().typeText("m")
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("Don't allow. Your note to the agent:")
    await keys().typeText("use the local copy in docs/")
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("› use the local copy in docs/")
    keys().pressEnter()
    expect(await answer).toEqual({ choice: "deny", note: "use the local copy in docs/" })
    // The input was never involved.
    expect(mounted!.app.input.plainText).toBe("")
  })

  test("never takes the user's text: while they type, the dock waits for Tab and every letter stays in the input", async () => {
    const { answer } = await asked({ typing: "also check the" })
    let frame = await mounted!.frame()
    expect(frame).toContain("Tab answers the question · your message stays as it is")
    expect(frame).toContain("Tab to answer")
    await keys().typeText(" network a n")
    await mounted!.settle()
    expect(mounted!.app.input.plainText).toBe("also check the network a n")
    keys().pressTab()
    arm()
    await keys().typeText("n")
    expect(await answer).toEqual({ choice: "deny" })
    await mounted!.settle()
    frame = await mounted!.frame()
    expect(mounted!.app.input.plainText).toBe("also check the network a n")
    expect(frame).not.toContain("Tab answers the question")
  })

  test("Esc goes back to the message without answering; a letter that is not the dock's goes to the input", async () => {
    const { answer } = await asked()
    arm()
    keys().pressEscape()
    await Bun.sleep(80)
    await mounted!.settle()
    expect(await mounted!.frame()).toContain("Tab answers the question")
    keys().pressTab()
    arm()
    await keys().typeText("w")
    await mounted!.settle()
    expect(mounted!.app.input.plainText).toBe("w")
    let settled = false
    void answer.then(() => (settled = true))
    await mounted!.settle()
    expect(settled).toBe(false)
  })

  test("Ctrl-C stops the turn; the withdrawn question closes the dock and is answered cancelled (null)", async () => {
    const { answer, backend, controller } = await asked()
    keys().pressCtrlC()
    await mounted!.settle()
    expect(backend.interrupts).toBe(1)
    // The client answers the pending request `cancelled` and aborts the question.
    controller.abort()
    expect(await answer).toBeNull()
    await mounted!.settle()
    expect(await mounted!.frame()).not.toContain("[a] Allow once")
  })

  test("a subagent that asks is named; none, nothing", async () => {
    await asked({ subagent: "test-fixer" })
    expect(await mounted!.frame()).toContain("asked by subagent test-fixer")
  })

  test("the dock goes away when the call is settled without it (the answer came, the turn ended)", async () => {
    const { session, answer } = await asked()
    const answered = ALL.find((item) => item.type === "approval.answered")!
    session.emit({ ...answered, seq: undefined } as never)
    expect(await answer).toBeNull()
  })
})

describe("the safety states in the conversation", () => {
  test("the rest of the scenario: allowed once, the sandbox marker with the extra access, taint, a declined call", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 120, height: 40, backend })
    backend.session!.emit(...ALL.map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never))
    await mounted.settle()
    const frame = await mounted.frame()
    // A command in the sandbox: a small mark; with extra access, the access spelled out.
    expect(frame).toMatch(/✓ shell curl -s https:\/\/example\.com\/notes ⊡ \+network · .*allowed once/)
    expect(frame).toMatch(/shell .* ⊡ · /)
    expect(frame).toContain("⚠ untrusted content is in the conversation: Content from a command that ran with")
    expect(frame).toContain("/clear-taint when you trust what is there")
    expect(frame).toContain("⊘ shell curl -s https://example.com/next · not allowed by you")
    expect(frame).toContain("the agent was told you declined")
    expect(frame).toContain("trust  untrusted · /clear-taint")
    expect(frame).not.toContain("waiting for your answer")
  })

  test("a replayed question is history: shown on its call, never as a live question", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    for (const item of UNTIL_QUESTION) backend.session!.queue.push({ event: item, replay: true })
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).not.toContain("waiting for your answer")
    expect(frame).not.toContain("waiting for your approval")
    expect(mounted.app.transcript.activity.waiting).toBeNull()
  })

  test("a call refused without a question, and a run ended because nobody could approve", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    const call = ALL.find((item): item is StoredEvent<"tool.called"> => item.type === "tool.called" && item.data.messageId === "a2")!
    backend.session!.emit(
      ...ALL.slice(0, ALL.indexOf(call) + 1).map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never),
      { type: "approval.denied", v: 1, data: { messageId: "a2", callId: "call_1", mode: "auto", paths: [], escalation: { network: true, write: [] }, reason: "unattended", needs: [{ kind: "sandbox-network" }], stop: true } } as never,
      { type: "tool.settled", v: 1, data: { messageId: "a2", callId: "call_1", outcome: "error", output: "Not run: needs approval.", truncation: null, attachments: [], display: null } } as never,
      { type: "execution.failed", v: 1, data: { executionId: (ALL.find((item) => item.type === "execution.started") as StoredEvent<"execution.started">).data.executionId, message: "A tool call needed approval and nobody was there to give it.", cause: "approval" } } as never,
    )
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("· refused: nobody was there to approve it")
    expect(frame).toContain("it needs network access for this command; the run ends")
    expect(frame).toContain("✗ failed (approval needed): A tool call needed approval and")
  })

  test("a notice is its own row", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    backend.session!.emit({ type: "notice", sessionId: "ses_script", kind: "sandbox_unavailable", message: "bubblewrap is not installed\nInstall bubblewrap to sandbox commands." } as never)
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("⚠ no sandbox: bubblewrap is not installed")
    expect(frame).toContain("Install bubblewrap to sandbox commands.")
  })
})

describe("commands", () => {
  test("/clear-taint asks first, saying what clearing means; y clears", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    const session = backend.session!
    let cleared = 0
    session.clearTaint = async () => {
      cleared += 1
      return true
    }
    session.emit(...ALL.slice(0, ALL.findIndex((item) => item.type === "taint.noticed") + 1).map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never))
    await mounted.settle()
    await keys().typeText("/clear-taint")
    keys().pressEnter()
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("Trust what is in this conversation?")
    expect(frame).toContain("Clearing says you trust it")
    expect(frame).toContain("[y] Yes, I trust it: clear")
    expect(frame).toContain("[n] No, keep asking")
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 100)).toBe(true)
    await keys().typeText("y")
    await mounted.settle()
    expect(cleared).toBe(1)
  })

  test("/approval: a picker with what each mode does; the choice is set and said", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    const session = backend.session!
    let mode = "auto"
    const set: string[] = []
    session.configChoices = (id) =>
      id === "approval"
        ? {
            current: mode,
            choices: [
              { value: "ask", name: "Ask", description: "Reads run; every edit, command and network call asks" },
              { value: "auto", name: "Auto", description: "Edits in the workspace and sandboxed commands run; leaving the sandbox asks" },
              { value: "full", name: "Full access", description: "Everything runs without the sandbox and without asking" },
            ],
          }
        : null
    session.setConfig = async (id, value) => {
      set.push(`${id}=${value}`)
      mode = value
    }
    session.approval = async () => ({ enabled: true, mode, tainted: false, taint: null, sandboxUnavailable: null })
    await keys().typeText("/approval")
    keys().pressEnter()
    await mounted.settle()
    let frame = await mounted.frame()
    expect(frame).toContain("Approval mode")
    expect(frame).toContain("Ask          Reads run; every edit, command and network call asks")
    expect(frame).toContain("Full access  Everything runs without the sandbox and without asking")
    expect(frame).toContain("[1] Ask")
    expect(frame).toMatch(/\[2\] Auto \(current\)/)
    expect(frame).toContain("[3] Full access")
    await keys().typeText("1")
    await mounted.settle()
    expect(set).toEqual(["approval=ask"])
    frame = await mounted.frame()
    expect(frame).toContain("approval mode: auto → ask · from the next tool call")
    expect(frame).toContain("approval ask · sandbox ⊡")
  })

  test("/diff: the per-file diff view, file by file, binary files flagged", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 20, backend })
    const session = backend.session!
    const asked: unknown[] = []
    const result: DiffResult = {
      available: true,
      scope: "turn",
      executionId: "exe_1",
      messageId: null,
      from: "a".repeat(40),
      to: "b".repeat(40),
      files: [
        { path: "src/add.ts", status: "modified", binary: false, truncated: false, omitted: false, added: 1, removed: 1, patch: "diff --git a/src/add.ts b/src/add.ts\nindex 1..2 100644\n--- a/src/add.ts\n+++ b/src/add.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number) {\n-  return a - b\n+  return a + b\n }\n" },
        { path: "logo.png", status: "added", binary: true, truncated: false, omitted: false, added: 0, removed: 0, patch: null },
        { path: "notes.md", status: "added", binary: false, truncated: true, omitted: false, added: 2, removed: 0, patch: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n" },
      ],
    }
    session.diff = async (params) => {
      asked.push(params)
      return result
    }
    session.emit(...ALL.slice(0, 3).map(({ sessionId: _, seq: __, time: ___, ...rest }) => rest as never))
    await keys().typeText("/diff")
    keys().pressEnter()
    await mounted.settle()
    const frame = await mounted.frame()
    expect(mounted.app.pager.open).toBe(true)
    expect(frame.split("\n").every((line) => Bun.stringWidth(line) <= 100)).toBe(true)
    expect(frame).toContain("Changes of this turn: 3 files · +3 -1")
    expect(frame).toContain("src/add.ts · +1 -1")
    expect(frame).toContain("notes.md · new file · +2 -0")
    expect(frame).toContain("-  return a - b")
    expect(frame).toContain("+  return a + b")
    expect(frame).toContain("logo.png · new file")
    expect(frame).toContain("binary file: no diff shown")
    expect(frame).not.toContain("index 1..2")
    expect(frame).toMatchSnapshot()
    // n jumps to the next file; Esc closes and the input is as it was.
    keys().pressKey("n")
    await mounted.settle()
    expect((await mounted.frame()).split("\n")[1]).toContain("logo.png")
    keys().pressKey("n")
    await mounted.settle()
    const last = await mounted.frame()
    expect(last.split("\n")[1]).toContain("notes.md")
    expect(last).toContain("cut: the change to this file is larger than the per-file limit")
    keys().pressEscape()
    await Bun.sleep(80)
    await mounted.settle()
    expect(mounted.app.pager.open).toBe(false)
    expect(asked).toEqual([{}])
  })

  test("a turn's ending row expands to the server's per-file diffs, and a replayed ending gets its changed files", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 40, backend })
    const session = backend.session!
    session.diff = async () => ({ available: true, scope: "turn", executionId: "exe_1", messageId: null, from: "a", to: "b", files: [{ path: "made-by-a-command.txt", status: "added", binary: false, truncated: false, omitted: false, added: 1, removed: 0, patch: "--- /dev/null\n+++ b/made-by-a-command.txt\n@@ -0,0 +1 @@\n+hello\n" }] })
    const executionId = (ALL.find((item) => item.type === "execution.started") as StoredEvent<"execution.started">).data.executionId
    for (const item of ALL) session.queue.push({ event: item, replay: true })
    session.turn({ sessionId: "ses_script", executionId, outcome: "succeeded", stopReason: "end_turn", changedFiles: ["made-by-a-command.txt"], replay: true })
    await mounted.settle()
    expect(await mounted.frame()).toContain("changed 1 file: made-by-a-command.txt · Ctrl-O for diffs")
    keys().pressKey("o", { ctrl: true })
    await mounted.settle()
    const frame = await mounted.frame()
    expect(frame).toContain("made-by-a-command.txt · new file · +1 -0")
    expect(frame).toContain("+hello")
  })

  test("/rename says it is not available, and which engine operation it waits for", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 100, height: 30, backend })
    await keys().typeText("/rename the parser")
    keys().pressEnter()
    await mounted.settle()
    const said = mounted.app.transcript.rows.flatMap((row) => (row.kind === "notice" ? [row.text.map((part) => part.text).join("")] : []))
    expect(said.at(-1)).toStartWith("/rename is not available: the engine has no operation to rename a session (EngineSession.rename")
  })
})
