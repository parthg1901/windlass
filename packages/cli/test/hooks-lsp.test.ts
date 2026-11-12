/**
 * Hooks and language servers at the line CLI, as a user meets them: a
 * project's hook and a project's language server are questions at the
 * prompt in the engine's own words (and, in a one-shot run, one sentence on
 * how to approve them); an edited hook is asked about again; `/hooks` and
 * `/lsp` say what is configured, where, and its state; a call a hook
 * refused, a note a hook added, a hook that could not answer, a turn that
 * ended with a stop hook unsatisfied and an edit that got diagnostics are
 * said on the rows they belong to.
 *
 * The configuration is real files under a throwaway `XDG_CONFIG_HOME` and the
 * workspace; the engine is the real server in this process with a scripted
 * model, the hooks are real commands, the language server is the scripted
 * one of the engine's tests.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CallId, type MessageId, brand, event } from "@windlass/core"
import { FakeProvider, script } from "@windlass/core/testing"
import { loadConfig, loadConfigSync } from "../../core/src/config/load.ts"
import { createAcpEngine } from "../src/acp-engine.ts"
import { render, runCli, stored } from "./helpers.ts"
import { VirtualTerminal } from "./vt.ts"

setDefaultTimeout(60_000)

const LSP_SERVER = join(import.meta.dir, "..", "..", "core", "test", "lsp", "fixtures", "server.ts")
const QUICK = { graceMs: 300, backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 } }
let root = ""
let saved: string | undefined
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-hooks-")))
  saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(root, "config")
})
afterAll(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = saved
  rmSync(root, { recursive: true, force: true })
})

let count = 0
const projectFile = (dir: string) => join(dir, `.${brand.directory}`, "config.json")
const userFile = () => join(root, "config", brand.directory, "config.json")
function workspace(project?: unknown, user?: unknown): string {
  const dir = join(root, `work${++count}`)
  mkdirSync(join(dir, `.${brand.directory}`), { recursive: true })
  if (project !== undefined) writeFileSync(projectFile(dir), JSON.stringify(project))
  rmSync(join(root, "config"), { recursive: true, force: true })
  if (user !== undefined) {
    mkdirSync(join(root, "config", brand.directory), { recursive: true })
    writeFileSync(userFile(), JSON.stringify(user))
  }
  return dir
}

const engineFor = (provider: FakeProvider, data: string) => () =>
  createAcpEngine({
    transport: "memory",
    harness: { dataDir: data, provider, log: () => {}, engine: { discover: () => [], lsp: QUICK, loadConfig: (cwd: string) => loadConfig({ cwd }), loadConfigSync: (cwd: string) => loadConfigSync({ cwd }) } },
    stderr: () => {},
  })

async function interactive(cwd: string, provider: FakeProvider, drive: (type: (keys: string) => void, waitFor: (needle: string | RegExp, ms?: number) => Promise<void>) => Promise<void>) {
  const vt = new VirtualTerminal(120)
  let seen = ""
  let typer: ((data: string) => void) | null = null
  const waitFor = async (needle: string | RegExp, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!(typeof needle === "string" ? seen.includes(needle) : needle.test(seen))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${String(needle)}; screen:\n${vt.text}`)
      await Bun.sleep(5)
    }
  }
  const running = runCli(["--cwd", cwd], {
    engine: engineFor(provider, join(cwd, "..", `data-${count}`)),
    stdinTTY: true,
    stdoutTTY: true,
    columns: 120,
    env: { NO_COLOR: "1" },
    keys: (type) => {
      typer = type
    },
    onWrite: (text) => {
      seen += text
      vt.write(text)
    },
  })
  await waitFor("› ")
  await drive((keys) => typer!(keys), waitFor)
  const result = await running
  return { ...result, seen: seen.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ") }
}

describe("a project's hook", () => {
  const hook = (command: string) => ({ hooks: { beforeTool: [{ name: "no-secrets", tools: ["write"], paths: ["secret.txt"], command }] } })

  test("is asked about at the prompt in the engine's words, runs once allowed, /hooks shows it, and an edited one is asked about again", async () => {
    const cwd = workspace(hook("echo 'Secrets are not written here.'; exit 2"))
    const provider = new FakeProvider([[script.toolCall("call_1", "write", { path: "secret.txt", content: "x\n" })], [script.text("It was refused.")], [script.text("Hello again.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      // Asked a moment after the session opened, before anything is sent.
      await waitFor(`? This project's configuration asks to run a hook "no-secrets" before a tool call`)
      await waitFor("[y] allow it · [N] not now")
      type("y\r")
      await waitFor('approved: the hook "no-secrets" runs from the next call it applies to')
      type("/hooks\r")
      await waitFor("no-secrets · in force")
      type("write the secret\r")
      await waitFor('refused by the hook "no-secrets"')
      await waitFor("✓ done")
      // The same hook with another command is another hook: the next turn reads it and it is asked about again.
      writeFileSync(projectFile(cwd), JSON.stringify(hook("exit 0")))
      type("hello\r")
      await waitFor("    exit 0")
      await waitFor(/\[y\] allow it · \[N\] not now[\s\S]*\[y\] allow it · \[N\] not now/)
      type("n\r")
      await waitFor('not allowed: the hook "no-secrets" is not run; /hooks approve no-secrets asks again')
      // The turn went on meanwhile, as if the hook were not there.
      await waitFor("Hello again.")
      await waitFor(/✓ done[\s\S]*✓ done/)
      type("/hooks\r")
      await waitFor("no-secrets · waiting for your approval: not run")
      type("\x04")
    })
    expect(run.code).toBe(0)
    // The question: the command word for word, what it applies to, where it is defined, what each answer does.
    expect(run.seen).toContain("echo 'Secrets are not written here.'; exit 2")
    expect(run.seen).toContain("It applies to the tools write, for paths matching secret.txt.")
    expect(run.seen).toContain("If the hook is changed, you will be asked again.")
    expect(run.seen.replace(/\r?\n\s+/g, " ")).toContain(`defined in: ${projectFile(cwd)}`)
    expect(run.seen).toContain("y allow it for this project and remember that (30 days, this exact definition")
    expect(run.seen).toContain("n not now: it is not run, and the work goes on as if it were not there")
    // The listing: when it runs, what it runs, what it applies to, where it is defined.
    expect(run.seen).toContain("Before a tool call:")
    expect(run.seen).toContain("applies to write, for paths matching secret.txt · at most 10 s")
    expect(run.seen.replace(/\r?\n\s+/g, " ")).toContain(`defined in this project's file: ${projectFile(cwd)}`)
    // The refusal names the hook and gives its reason.
    expect(run.seen).toContain("Secrets are not written here.")
  })

  test("in a one-shot run nobody can approve it: it is skipped, said once, with how to approve it", async () => {
    const cwd = workspace(hook("exit 2"))
    const provider = new FakeProvider([[script.toolCall("call_1", "write", { path: "secret.txt", content: "x\n" })], [script.text("Written.")]])
    const run = await runCli(["--cwd", cwd, "write the secret"], { engine: engineFor(provider, join(root, `data-oneshot-${count}`)), env: { NO_COLOR: "1" } })
    const flat = (run.out + run.err).replace(/\s+/g, " ")
    expect(run.code).toBe(0)
    expect(flat.match(/It is not run: a hook a project names runs only after you approve it\./g)).toHaveLength(1)
    expect(flat.match(/Approving the hook "no-secrets" needs someone at the terminal/g)).toHaveLength(1)
    expect(flat).toContain(`run \`${brand.binary}\` in this directory and answer the question it asks (or type /hooks approve no-secrets)`)
    // Skipped: the call went through.
    expect(flat).not.toContain("refused by the hook")
    expect(flat).toContain("✓ done")
  })
})

describe("what a hook did", () => {
  test("a refused call, a note, a hook that cannot answer and a turn that ends with a stop hook unsatisfied, with the user's own hooks", async () => {
    const cwd = workspace(undefined, {
      hooks: {
        beforeTool: [{ name: "no-secrets", tools: ["write"], paths: ["secret.txt"], command: "echo 'Secrets are not written here.'; exit 2" }],
        afterTool: [
          { name: "reminder", tools: ["write"], paths: ["a.txt"], command: "echo 'Run the formatter before you finish.'; exit 2" },
          { name: "broken", tools: ["write"], paths: ["a.txt"], command: "echo 'no formatter installed' >&2; exit 7" },
        ],
        stop: [{ name: "never-done", command: "echo 'SCRATCH.md still exists.'; exit 2" }],
        maxStopRounds: 1,
      },
    })
    const provider = new FakeProvider([
      [script.toolCall("call_1", "write", { path: "secret.txt", content: "x\n" })],
      [script.toolCall("call_2", "write", { path: "a.txt", content: "one\n" })],
      [script.text("Done.")],
      [script.text("Still done.")],
    ])
    const run = await runCli(["--cwd", cwd, "write both files"], { engine: engineFor(provider, join(root, `data-did-${count}`)), env: { NO_COLOR: "1" } })
    const out = run.out + run.err
    const flat = out.replace(/\s+/g, " ")
    expect(flat).toContain('⊘ refused by the hook "no-secrets" Secrets are not written here.')
    expect(flat).toContain('note from the hook "reminder", added to the result: Run the formatter before you finish.')
    // A hook that could not answer is said once, in the engine's words, with what that means.
    expect(flat.match(/could not answer/g)).toHaveLength(1)
    expect(flat).toMatch(/⚠ hook: The hook "broken" \(after a tool call\) could not answer: [^.]*7[^.]*\. Nothing was added to the result\./)
    expect(flat).toContain('the hook "broken" printed: no formatter installed')
    expect(flat).toContain('↻ the stop hook "never-done" did not let the turn end · the agent is sent back with what it said SCRATCH.md still exists.')
    expect(flat).toContain('⚠ ended with the stop hook "never-done" unsatisfied · no checks configured')
    // What the hook said is said where the agent was sent back, and nothing is made up for the ending.
    expect(flat).not.toContain("it gave no reason")
    // Nothing of it is called a note to the model or an internal problem.
    expect(flat).not.toContain("note to the model")
    expect(run.code).toBe(0)
  })

  const m = (id: string) => id as MessageId
  const c = (id: string) => id as CallId
  const record = (more: Record<string, unknown>) =>
    event("hook.ran", { point: "beforeTool", messageId: m("m1"), callId: c("c1"), hookId: "user.beforeTool[0]", name: "guard", origin: "user", fingerprint: "f".repeat(64), run: { kind: "ran", sandbox: null }, answer: "yes", failure: null, detail: null, exitCode: 0, durationMs: 5, toModel: null, forUser: "", taint: null, ...more } as never)
  const settled = (more: Record<string, unknown>) => event("tool.settled", { messageId: m("m1"), callId: c("c1"), outcome: "success", output: "Edited src/app.ts (1 change).", truncation: null, attachments: [], display: null, ...more } as never)
  const called = (name: string, input: unknown) => event("tool.called", { messageId: m("m1"), callId: c("c1"), name, input: JSON.stringify(input), providerData: null })

  test("a before hook that timed out refuses the call, and the row says which hook and why", () => {
    const out = render(
      stored([
        called("shell", { command: "git push" }),
        record({ answer: "failed", failure: "timed_out", detail: "timed out after 10 s", exitCode: null }),
        settled({ outcome: "error", output: 'This call was not run: the hook "guard" is failing (timed out after 10 s).' }),
      ]),
    )
    expect(out.replace(/\s+/g, " ")).toContain('⊘ refused: the hook "guard" must allow it and could not answer (timed out after 10 s)')
  })

  test("an edit whose result got diagnostics says how many and from which server; one that got none says nothing on its row", () => {
    const diagnostics = (outcome: string, added: number) => ({ noteAdded: added > 0, listed: added, omitted: 0, waitedMs: 120, servers: [{ name: "typescript", origin: "user", fingerprint: "a".repeat(16), outcome, new: added, preExisting: 3, fixed: 0 }] })
    const withNote = render(stored([called("edit", { path: "src/app.ts", old: "a", new: "b" }), event("tool.started", { messageId: m("m1"), callId: c("c1") } as never), settled({ diagnostics: diagnostics("compared", 2) })]))
    expect(withNote).toContain("2 new diagnostics from typescript")
    const without = render(stored([called("edit", { path: "src/app.ts", old: "a", new: "b" }), event("tool.started", { messageId: m("m1"), callId: c("c1") } as never), settled({ diagnostics: diagnostics("timeout", 0) })]))
    expect(without).not.toContain("diagnostic")
    expect(without).toContain("✓")
  })

  test("what the engine says about a language server is a note, not a warning; about a hook it is a warning headed as one", () => {
    const starting = `The language server "typescript" was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready.`
    const out = render([
      { type: "diagnostic", sessionId: "ses_test", kind: "lsp", message: starting } as never,
      { type: "diagnostic", sessionId: "ses_test", kind: "hooks", message: 'The hook "fmt" (after a tool call) could not answer: timed out after 10 s. Nothing was added to the result.' } as never,
    ])
    expect(out.replace(/\s+/g, " ")).toContain(`· language server: ${starting}`)
    expect(out).not.toContain("⚠ lsp")
    expect(out).toContain('⚠ hook: The hook "fmt"')
  })
})

describe("language servers", () => {
  const server = (flags: readonly string[] = []) => ({ command: process.execPath, args: [LSP_SERVER, ...flags], languages: { plaintext: ["**/*.txt"] } })

  test("a project's server is asked about at the prompt; allowed, /lsp shows what it serves and where it is defined", async () => {
    const cwd = workspace({ lsp: { waitMs: 5000, servers: { fixture: server() } } })
    const provider = new FakeProvider([[script.text("Hello.")]])
    const run = await interactive(cwd, provider, async (type, waitFor) => {
      await waitFor('? Start the language server "fixture" that this project\'s configuration names?')
      await waitFor("[y] allow it · [N] not now")
      type("y\r")
      await waitFor('approved: the language server "fixture" starts at the next file it serves')
      type("/lsp\r")
      await waitFor("fixture · not started yet: it starts when the agent reads or edits a file it serves")
      type("\x04")
    })
    expect(run.code).toBe(0)
    expect(run.seen).toContain("fixtures/server.ts")
    expect(run.seen).toContain("It runs outside the sandbox, with your permissions.")
    expect(run.seen.replace(/\r?\n\s+/g, " ")).toContain(`defined in: ${projectFile(cwd)}`)
    expect(run.seen).toContain("y allow it for this project and remember that (30 days, this exact definition")
    expect(run.seen).toContain("n not now: it is not started and edits get no diagnostics from it; /lsp approve fixture asks again")
    expect(run.seen).toContain("Language servers (1):")
    expect(run.seen).toContain("An edit's result waits at most 5000 ms for diagnostics")
    expect(run.seen).toContain("serves **/*.txt")
    expect(run.seen.replace(/\r?\n\s+/g, " ")).toContain(`defined in this project's file: ${projectFile(cwd)}`)
    // Not headed as a problem: a note.
    expect(run.seen).toContain("· language server: This project's configuration names the language server")
  })

  test("a hook and a language server that wait at once are asked about one after the other, and each answer goes to its own question", async () => {
    const cwd = workspace({ hooks: { stop: [{ name: "tidy", command: "exit 0" }] }, lsp: { servers: { fixture: server() } } })
    const run = await interactive(cwd, new FakeProvider([]), async (type, waitFor) => {
      await waitFor(`? This project's configuration asks to run a hook "tidy" when a turn is about to end`)
      await waitFor("[y] allow it · [N] not now")
      type("y\r")
      await waitFor('approved: the hook "tidy" runs from the next call it applies to')
      await waitFor('? Start the language server "fixture" that this project\'s configuration names?')
      await waitFor(/\[y\] allow it · \[N\] not now[\s\S]*\[y\] allow it · \[N\] not now/)
      type("n\r")
      await waitFor('not allowed: the language server "fixture" is not started; /lsp approve fixture asks again')
      type("/hooks\r")
      await waitFor("tidy · in force")
      type("\x04")
    })
    expect(run.code).toBe(0)
    // Neither question was backed out of to make room for the other.
    expect(run.seen).not.toContain('not allowed: the hook "tidy"')
  })

  test("in a one-shot run a project's server is not started: said once, with how to approve it; /lsp with none says how to add one", async () => {
    const cwd = workspace({ lsp: { servers: { fixture: server() } } })
    const provider = new FakeProvider([[script.text("Done.")]])
    const run = await runCli(["--cwd", cwd, "hello"], { engine: engineFor(provider, join(root, `data-lsp-oneshot-${count}`)), env: { NO_COLOR: "1" } })
    const flat = (run.out + run.err).replace(/\s+/g, " ")
    expect(flat.match(/It was not started: a server a project names runs only after you approve it\./g)).toHaveLength(1)
    expect(flat.match(/Approving the language server "fixture" needs someone at the terminal/g)).toHaveLength(1)
    expect(flat).toContain("(or type /lsp approve fixture)")

    const none = await interactive(workspace(), new FakeProvider([]), async (type, waitFor) => {
      type("/lsp\r")
      await waitFor("No language server is configured for this session.")
      type("/hooks\r")
      await waitFor("No hook is configured for this session.")
      type("\x04")
    })
    expect(none.seen).toContain(`"lsp": { "servers": { ... } }`)
    expect(none.seen).toContain(`"hooks": { "beforeTool": [ ... ]`)
  })
})
