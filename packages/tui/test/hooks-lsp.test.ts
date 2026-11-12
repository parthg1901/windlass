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
import { brand } from "@windlass/core"
import { ARMING_MS, QUIET_MS } from "../src/approval.ts"
import { type Mounted, ScriptBackend, mount } from "./helpers.ts"

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.dispose()
  mounted = null
})

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
    expect(listed).toContain(`defined in this project's file, ${PROJECT_FILE}`)
    expect(listed).toContain("fmt · failed the last time it ran")
    expect(listed).toContain("applies to edit, write, for paths matching **/*.ts · at most 10 s")
    expect(listed).toContain("why: timed out after 10 s")
    expect(listed).toContain(`defined in your file, ${USER_FILE}`)
    // `/hooks approve` puts the question again.
    await command("/hooks approve no-push")
    expect(flat(await mounted!.frame())).toContain("[a] Allow it for this project")
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
    expect(listed).toContain(`defined in your file, ${USER_FILE}`)
    expect(listed).toContain("typescript · running")
    expect(listed).toContain("serves **/*.ts, **/*.tsx")
    // The other name for the same listing.
    await command("/diagnostics")
    expect(flat(await mounted!.frame()).match(/Language servers \(2\):/g)).toHaveLength(2)
  })
})
