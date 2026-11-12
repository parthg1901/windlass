/**
 * Hooks and language servers in the real `App`: a project's hook and a
 * project's language server are put in the approval dock with the engine's
 * own question (the command, what it applies to, where it is defined, what
 * each answer does) and allowed by a key; an edited hook is another
 * question; `/hooks` and `/lsp` show the line CLI's words; a call a hook
 * refused, a note a hook added, a hook that could not answer (in a stored
 * session), a stop hook that sent the agent back, a turn that ended with one
 * unsatisfied, and an edit that got diagnostics are drawn where they belong.
 */
import { afterEach, describe, expect, test } from "bun:test"
import type { HookInfo, HooksStateResult, LspServerInfo, LspStateResult } from "@windlass/acp/extensions"
import { type CallId, type MessageId, brand, event } from "@windlass/core"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import { type Mounted, ScriptBackend, mount, said } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

const m = (id: string) => id as MessageId
const c = (id: string) => id as CallId
const flat = (frame: string) => frame.replace(/\s+/g, " ")
const PROJECT_FILE = `/work/.${brand.directory}/config.json`
const USER_FILE = `/home/u/.config/${brand.directory}/config.json`

const question = (command: string) =>
  [
    `This project's configuration asks to run a hook "no-push" before a tool call runs, and can refuse the call:`,
    "",
    `    ${command}`,
    "",
    "It applies to the tools shell.",
    "It runs in the sandbox with no network (outside it only in the full mode), for at most 10 seconds each time. Allow it for this project? If the hook is changed, you will be asked again.",
  ].join("\n")

const hook = (command: string, fingerprint: string): HookInfo => ({
  name: "no-push",
  point: "beforeTool",
  state: "awaiting_approval",
  command,
  tools: ["shell"],
  paths: null,
  timeoutSeconds: 10,
  onError: "refuse",
  sandbox: true,
  origin: "project",
  file: PROJECT_FILE,
  fingerprint,
  error: null,
  question: question(command),
})
const hooks = (sessionId: string, list: readonly HookInfo[]): HooksStateResult => ({ sessionId, available: true, hooks: list, maxStopRounds: 3, ignored: [] })

const SERVER: LspServerInfo = {
  name: "typescript",
  state: "awaiting_approval",
  command: "typescript-language-server --stdio",
  argv: ["typescript-language-server", "--stdio"],
  languages: [{ languageId: "typescript", patterns: ["**/*.ts", "**/*.tsx"] }],
  processes: [],
  error: null,
  origin: "project",
  file: PROJECT_FILE,
  question: {
    fingerprint: "0123456789abcdef",
    subject: "typescript-language-server --stdio",
    details: ['This project\'s configuration names the language server "typescript", started by running that command when the agent edits **/*.ts, **/*.tsx. It runs outside the sandbox, with your permissions.'],
  },
}
const servers = (sessionId: string, list: readonly LspServerInfo[]): LspStateResult => ({ sessionId, available: true, off: null, waitMs: 1500, servers: list })

async function open(width = 190, height = 44) {
  const backend = new ScriptBackend()
  mounted = await mount({ width, height, backend })
  return { backend, session: backend.session!, mounted }
}

async function command(text: string) {
  await mounted!.setup.mockInput.typeText(text)
  mounted!.setup.mockInput.pressEnter()
  await mounted!.settle()
}

describe("a project's hook", () => {
  test("waits in the dock with the engine's question; `a` allows it; an edited one is asked about again; /hooks lists them", async () => {
    const { session } = await open()
    const approved: string[] = []
    session.approveHook = async (fingerprint) => {
      approved.push(fingerprint)
      return true
    }
    const first = hook("case \"$CMD\" in *'git push'*) exit 2;; esac", "a".repeat(64))
    mounted!.clock.now += QUIET_MS + 10
    session.pushHooks(hooks(session.id, [first]))
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain(`This project's configuration asks to run a hook "no-push" before a tool call runs, and can refuse the call:`)
    expect(frame).toContain("case \"$CMD\" in *'git push'*) exit 2;; esac")
    expect(frame).toContain("It applies to the tools shell.")
    expect(frame).toContain("If the hook is changed, you will be asked again.")
    expect(frame).toContain(`Defined in ${PROJECT_FILE}.`)
    expect(frame).toContain("[a] Allow it for this project")
    expect(frame).toContain("Not now: it is not run, and the work goes on as if it were not there")
    // The same definition is not asked about twice.
    session.pushHooks(hooks(session.id, [first]))
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("a")
    await mounted!.settle()
    expect(approved).toEqual(["a".repeat(64)])
    const after = flat(await mounted!.frame())
    expect(after).toContain('approved: the hook "no-push" runs from the next call it applies to')
    expect(after).not.toContain("[a] Allow it for this project")

    // The hook was edited: another definition, another question.
    const edited = hook("exit 2", "b".repeat(64))
    mounted!.clock.now += QUIET_MS + 10
    session.pushHooks(hooks(session.id, [edited]))
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("[a] Allow it for this project")
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("n")
    await mounted!.settle()
    expect(approved).toHaveLength(1)
    expect(flat(await mounted!.frame())).toContain('the hook "no-push" is not run; /hooks approve no-push asks again')

    const own: HookInfo = { ...edited, name: "fmt", point: "afterTool", state: "failed", origin: "user", file: USER_FILE, tools: ["edit", "write"], paths: ["**/*.ts"], question: null, error: "timed out after 10 s", fingerprint: "c".repeat(64) }
    session.hooks = async () => hooks(session.id, [edited, own])
    await command("/hooks")
    const listed = flat(await mounted!.frame())
    expect(listed).toContain("Hooks (2):")
    expect(listed).toContain("no-push · waiting for your approval: not run")
    expect(listed).toContain(`defined in this project's file: ${PROJECT_FILE}`)
    expect(listed).toContain("fmt · failed the last time it ran")
    expect(listed).toContain("applies to edit, write, for paths matching **/*.ts · at most 10 s")
    expect(listed).toContain("why: timed out after 10 s")
    expect(listed).toContain(`defined in your file: ${USER_FILE}`)
    // `/hooks approve` puts the question again.
    await command("/hooks approve no-push")
    expect(flat(await mounted!.frame())).toContain("[a] Allow it for this project")
  })
})

describe("when a session opens", () => {
  test("a project's hook and language server that wait are asked about at once, one after the other, and again in the next session", async () => {
    const backend = new ScriptBackend()
    const waiting = hook("exit 0", "d".repeat(64))
    // The server's own word that they changed never arrives here: the question does not depend on it.
    backend.prepare = (session) => {
      session.hooks = async () => hooks(session.id, [waiting])
      session.lsp = async () => servers(session.id, [SERVER])
    }
    mounted = await mount({ width: 190, height: 44, backend })
    const opened = flat(await mounted.frame())
    // The session is not ready for a message while the question waits: the status line says what it waits for.
    expect(opened).not.toContain("● ready")
    expect(opened).toContain('? waiting for your answer · the hook "no-push"')
    expect(opened).toContain('asks to run a hook "no-push" before a tool call runs')
    expect(opened).not.toContain('Start the language server "typescript"')
    expect(backend.sent).toEqual([])
    mounted.clock.now += ARMING_MS + 10
    await mounted.setup.mockInput.typeText("n")
    await mounted.settle()
    const second = flat(await mounted.frame())
    expect(second).toContain('the hook "no-push" is not run; /hooks approve no-push asks again')
    expect(second).toContain('Start the language server "typescript" that this project\'s configuration names?')
    expect(second).toContain('? waiting for your answer · the language server "typescript"')
    mounted.clock.now += ARMING_MS + 10
    await mounted.setup.mockInput.typeText("n")
    await mounted.settle()
    expect(flat(await mounted.frame())).not.toContain("[a] Allow it for this project")
    expect(flat(await mounted.frame())).toContain("● ready")

    // Another session in the same run: what was answered "not now" is asked about again there.
    await command("/new")
    mounted.clock.now += QUIET_MS + 10
    await mounted.settle()
    expect(flat(await mounted.frame())).toContain('asks to run a hook "no-push" before a tool call runs')
  })
})

describe("Ctrl-C at a question about the project's configuration", () => {
  test("with no turn running it answers not now and says so; with text being written it clears the text first", async () => {
    const { session, backend } = await open()
    const approved: string[] = []
    session.approveHook = async (fingerprint) => (approved.push(fingerprint), true)
    mounted!.clock.now += QUIET_MS + 10
    session.pushHooks(hooks(session.id, [hook("exit 0", "e".repeat(64))]))
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("Esc back to your message · Ctrl-C answers not now")
    mounted!.setup.mockInput.pressCtrlC()
    await mounted!.settle()
    const declined = flat(await mounted!.frame())
    expect(declined).toContain('the hook "no-push" is not run; /hooks approve no-push asks again')
    expect(declined).not.toContain("[a] Allow it for this project")
    expect(approved).toEqual([])
    expect(backend.interrupts).toBe(0)

    // Someone writing a message: the first Ctrl-C clears it and the question stays, the second answers it.
    await mounted!.setup.mockInput.typeText("fix the")
    session.pushHooks(hooks(session.id, [hook("exit 1", "f".repeat(64))]))
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("Tab answers the question · your message stays as it is")
    mounted!.setup.mockInput.pressCtrlC()
    await mounted!.settle()
    expect(mounted!.app.input.plainText).toBe("")
    expect(flat(await mounted!.frame())).toContain("[a] Allow it for this project")
    mounted!.setup.mockInput.pressCtrlC()
    await mounted!.settle()
    expect(flat(await mounted!.frame())).not.toContain("[a] Allow it for this project")
    expect(flat(await mounted!.frame()).match(/the hook "no-push" is not run/g)).toHaveLength(2)
  })

  test("while a turn runs it stops the turn, and the question stays to be answered", async () => {
    const { session, backend } = await open()
    session.emit(event("execution.started", { executionId: "exe_1" } as never))
    mounted!.clock.now += QUIET_MS + 10
    session.pushHooks(hooks(session.id, [hook("exit 0", "e".repeat(64))]))
    await mounted!.settle()
    expect(flat(await mounted!.frame())).toContain("Esc back to your message · Ctrl-C stops the turn")
    mounted!.setup.mockInput.pressCtrlC()
    await mounted!.settle()
    expect(backend.interrupts).toBe(1)
    session.emit(event("execution.interrupt_requested", { executionId: "exe_1", reason: "user" } as never), event("execution.interrupted", { executionId: "exe_1", reason: "user" } as never))
    await mounted!.settle()
    const after = flat(await mounted!.frame())
    expect(after).toContain("■ interrupted")
    expect(after).toContain("[a] Allow it for this project")
    expect(after).toContain("Ctrl-C answers not now")
  })
})

describe("a project's language server", () => {
  test("waits in the dock with what it runs and serves; `a` allows it; /lsp lists the servers with the files they serve", async () => {
    const { session } = await open()
    const approved: string[] = []
    session.approveLsp = async (name, fingerprint) => {
      approved.push(`${name}:${fingerprint}`)
      return true
    }
    mounted!.clock.now += QUIET_MS + 10
    session.pushLsp(servers(session.id, [SERVER]))
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain('Start the language server "typescript" that this project\'s configuration names?')
    expect(frame).toContain("typescript-language-server --stdio")
    expect(frame).toContain("when the agent edits **/*.ts, **/*.tsx. It runs outside the sandbox, with your permissions.")
    expect(frame).toContain(`Defined in ${PROJECT_FILE}.`)
    expect(frame).toContain("[a] Allow it for this project")
    expect(frame).toContain("Not now: it is not started and edits get no diagnostics from it")
    mounted!.clock.now += ARMING_MS + 10
    await mounted!.setup.mockInput.typeText("a")
    await mounted!.settle()
    expect(approved).toEqual(["typescript:0123456789abcdef"])
    expect(flat(await mounted!.frame())).toContain('approved: the language server "typescript" starts at the next file it serves')

    const failed: LspServerInfo = { ...SERVER, name: "python", state: "failed", command: "pyright-langserver --stdio", languages: [{ languageId: "python", patterns: ["**/*.py"] }], origin: "user", file: USER_FILE, question: null, error: "it could not be started: pyright-langserver was not found on PATH", processes: [{ root: "/work", state: "failed", error: "it could not be started: pyright-langserver was not found on PATH", restarts: 0, openDocuments: 0 }] }
    session.lsp = async () => servers(session.id, [failed, { ...SERVER, state: "running", question: null, processes: [{ root: "/work", state: "running", error: null, restarts: 0, openDocuments: 2 }] }])
    await command("/lsp")
    const listed = flat(await mounted!.frame())
    expect(listed).toContain("Language servers (2):")
    expect(listed).toContain("python · failed: it is started again at a later edit")
    expect(listed).toContain("why: it could not be started: pyright-langserver was not found on PATH")
    expect(listed).toContain("serves **/*.py")
    expect(listed).toContain(`defined in your file: ${USER_FILE}`)
    expect(listed).toContain("typescript · running")
    expect(listed).toContain("serves **/*.ts, **/*.tsx")
    // The other name for the same listing.
    await command("/diagnostics")
    expect(flat(await mounted!.frame()).match(/Language servers \(2\):/g)).toHaveLength(2)
  })
})

describe("what a hook did, and what the language servers said", () => {
  const ran = (more: Record<string, unknown>) =>
    event("hook.ran", { point: "beforeTool", messageId: m("m1"), callId: c("c1"), hookId: "user.beforeTool[0]", name: "no-push", origin: "user", fingerprint: "f".repeat(64), run: { kind: "ran", sandbox: null }, answer: "yes", failure: null, detail: null, exitCode: 0, durationMs: 5, toModel: null, forUser: "", taint: null, ...more } as never)
  const called = (call: string, name: string, input: unknown) => event("tool.called", { messageId: m("m1"), callId: c(call), name, input: JSON.stringify(input), providerData: null })
  const settled = (call: string, more: Record<string, unknown>) => event("tool.settled", { messageId: m("m1"), callId: c(call), outcome: "success", output: "ok", truncation: null, attachments: [], display: null, ...more } as never)

  test("a refused call names the hook and its reason; a note and what a hook printed sit under the call; diagnostics are counted on the row", async () => {
    const { session } = await open()
    session.emit(
      event("execution.started", { executionId: "exe_1" } as never),
      called("c1", "shell", { command: "git push origin main" }),
      ran({ answer: "no", exitCode: 2, toModel: "Pushing is not allowed here. Commit locally and tell the user." }),
      settled("c1", { outcome: "error", output: 'This call was not run: the hook "no-push" refused it.\nPushing is not allowed here. Commit locally and tell the user.' }),
      called("c2", "edit", { path: "src/app.ts", old: "a", new: "b" }),
      event("tool.started", { messageId: m("m1"), callId: c("c2") } as never),
      ran({ point: "afterTool", callId: c("c2"), name: "prettier", answer: "no", exitCode: 2, toModel: "prettier could not format this file; run it to see why.", forUser: "src/app.ts: SyntaxError (3:1)" }),
      settled("c2", {
        output: "Edited src/app.ts (1 change).",
        diagnostics: { noteAdded: true, listed: 2, omitted: 0, waitedMs: 300, servers: [{ name: "typescript", origin: "user", fingerprint: "a".repeat(16), outcome: "compared", new: 2, preExisting: 3, fixed: 0 }] },
      }),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain('⊘ shell git push origin main · refused by the hook "no-push"')
    expect(frame).toContain("Pushing is not allowed here. Commit locally and tell the user.")
    expect(frame).not.toContain("This call was not run")
    expect(frame).toContain("2 new diagnostics from typescript")
    expect(frame).toContain('note from the hook "prettier", added to the result: prettier could not format this file; run it to see why.')
    expect(frame).toContain('the hook "prettier" printed: src/app.ts: SyntaxError (3:1)')
  })

  test("a stop hook that sends the agent back says what it said; a turn that ends with it unsatisfied is its own ending", async () => {
    const { session } = await open()
    const stop = (more: Record<string, unknown>) => ran({ point: "stop", messageId: null, callId: null, name: "no-scratch", answer: "no", exitCode: 2, ...more })
    session.emit(
      event("execution.started", { executionId: "exe_1" } as never),
      stop({ toModel: "SCRATCH.md still exists. Delete it before you finish." }),
      event("synthetic.appended", { messageId: m("m2"), origin: "stop_hook", text: "[Stop hook 1 of at most 1] The turn cannot end yet." } as never),
      stop({}),
      event("execution.succeeded", { executionId: "exe_1", verification: { status: "not_configured" }, hooks: { unsatisfied: ["no-scratch"], objections: [{ hook: "no-scratch", text: "SCRATCH.md is still there. Nobody deleted it." }] } } as never),
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain('↻ the stop hook "no-scratch" did not let the turn end · the agent is sent back with what it said')
    expect(frame).toContain("SCRATCH.md still exists. Delete it before you finish.")
    expect(frame).toContain('⚠ ended with the stop hook "no-scratch" unsatisfied · no checks configured')
    // The last round sent nobody back, so its record has no text: the ending says what the hook said then.
    expect(frame).toContain("SCRATCH.md is still there. Nobody deleted it.")
    expect(frame).not.toContain("note to the model")
    expect(frame).not.toContain("hook.ran")
  })

  test("the engine's word about a language server is a note, about a hook a warning; neither is an event the client does not know", async () => {
    const { session } = await open()
    session.emit(
      { type: "diagnostic", sessionId: session.id, kind: "lsp", message: 'The language server "typescript" was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready.' } as never,
      { type: "diagnostic", sessionId: session.id, kind: "hooks", message: 'The hook "fmt" (after a tool call) could not answer: timed out after 10 s. Nothing was added to the result.' } as never,
    )
    await mounted!.settle()
    const frame = flat(await mounted!.frame())
    expect(frame).toContain('· language server: The language server "typescript" was still starting')
    expect(frame).toContain('⚠ hook: The hook "fmt" (after a tool call) could not answer')
  })
})

describe("before a message is sent", () => {
  test("a project's hook that waits is asked about first: the message is held until the answer, then sent with what was allowed", async () => {
    const backend = new ScriptBackend()
    mounted = await mount({ width: 150, height: 44, backend })
    const session = backend.session!
    const approved: string[] = []
    const waiting = hook("exit 2", "d".repeat(64))
    session.hooks = async () => hooks(session.id, [waiting])
    session.approveHook = async (fingerprint) => (approved.push(fingerprint), true)
    // Typed before the server said anything about the hooks: the question is put now, and the message waits for it.
    await mounted.setup.mockInput.typeText("fix the test")
    mounted.setup.mockInput.pressEnter()
    await mounted.settle()
    const held = flat(await mounted.frame())
    expect(backend.sent).toEqual([])
    expect(held).toContain("your message is sent once the question below is answered")
    expect(held).toContain("[a] Allow it for this project")
    // Nothing is being typed any more: the question has the keys.
    mounted.clock.now += ARMING_MS + 10
    await mounted.setup.mockInput.typeText("a")
    await mounted.settle()
    expect(approved).toEqual(["d".repeat(64)])
    expect(backend.sent).toEqual([{ text: "fix the test", delivery: "steer" }])
    // Asked once: the next message goes at once.
    await mounted.setup.mockInput.typeText("and the docs")
    mounted.setup.mockInput.pressEnter()
    await mounted.settle()
    expect(backend.sent.map((item) => item.text)).toEqual(["fix the test", "and the docs"])
  })

  test("a project's MCP server is asked about as soon as the session opens, before any message; approving one mid-turn says when the agent has it", async () => {
    const backend = new ScriptBackend()
    const server = { name: "issues", state: "awaiting_approval" as const, transport: "stdio" as const, target: "bun server.ts", argv: ["bun", "server.ts"], tools: null, hiddenTools: 0, error: null, retryInMs: null, origin: "project" as const, file: PROJECT_FILE, question: { fingerprint: "f1", subject: "bun server.ts", details: [] } }
    let approved = 0
    backend.prepare = (opened) => {
      opened.mcp = async () => ({ sessionId: opened.id, available: true, servers: approved > 0 ? [{ ...server, state: "running" as const, question: null }] : [server] })
      opened.approveMcp = async () => {
        approved += 1
        return true
      }
    }
    mounted = await mount({ width: 200, height: 44, backend })
    const session = backend.session!
    await mounted.settle()
    // Nothing was typed or sent: the question is there with the session.
    const open = flat(await mounted.frame())
    expect(open).toContain('? Start the MCP server "issues" that this project\'s configuration names?')
    expect(open).not.toContain("not looked at yet")
    expect(backend.sent).toEqual([])
    mounted.clock.now += QUIET_MS + ARMING_MS + 10
    await mounted.settle()
    mounted.clock.now += ARMING_MS + 10
    await mounted.setup.mockInput.typeText("n")
    await mounted.settle()
    expect(flat(await mounted.frame())).toContain("/mcp approve issues asks again")
    // The first message goes at once, with no paragraph about what the engine has yet to look at.
    await mounted.setup.mockInput.typeText("hello")
    mounted.setup.mockInput.pressEnter()
    await mounted.settle()
    expect(backend.sent).toEqual([{ text: "hello", delivery: "steer" }])
    const sent = flat(await mounted.frame())
    expect(sent).not.toContain("A project's server starts only once you have approved it")
    expect(sent).not.toContain("cannot be approved yet")
    // The turn runs and the user asks for the question again: a yes now says the agent has it from the next message.
    session.emit(event("execution.started", { executionId: "exe_1" as never }))
    await command("/mcp approve issues")
    mounted.clock.now += QUIET_MS + 10
    await mounted.settle()
    mounted.clock.now += ARMING_MS + 10
    await mounted.setup.mockInput.typeText("a")
    await mounted.settle()
    const after = flat(await mounted.frame())
    expect(after).toContain('approved: "issues" starts now. The turn in progress began without it, so the agent may already have said it has no such tools')
    expect(said(await mounted.frame())).toContain("ask again in your next message")
  })
})
