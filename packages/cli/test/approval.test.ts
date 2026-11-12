/**
 * Approval at the command line: the flags, the answer typed at the prompt,
 * and what an unattended run says and exits with. The run tests start the
 * real CLI, which starts the real `acp` server, with a scripted model.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT_ENV } from "@light-harness/acp"
import type { CallId, MessageId, Question } from "@light-harness/core"
import { helpText, parseArgs } from "../src/args.ts"
import { EXIT_APPROVAL_REQUIRED } from "../src/engine.ts"
import { approverAt } from "../src/main.ts"

const CLI = join(import.meta.dir, "..", "src", "main.ts")
const scratch: string[] = []
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

describe("the flags", () => {
  const options = (argv: string[]) => {
    const parsed = parseArgs(argv)
    if (parsed.kind !== "run") throw new Error(`not a run: ${JSON.stringify(parsed)}`)
    return parsed.options
  }
  const errorOf = (argv: string[]) => {
    const parsed = parseArgs(argv)
    return parsed.kind === "error" ? parsed.message : null
  }

  test("--approval and --unattended are read, with or without `=`, and default to the configuration's", () => {
    expect(options(["fix it"])).toMatchObject({ approval: null, unattended: null })
    expect(options(["--approval", "ask", "--unattended=stop", "fix it"])).toMatchObject({ approval: "ask", unattended: "stop", prompt: "fix it" })
    expect(options(["--approval=full", "fix it"]).approval).toBe("full")
  })

  test("a value that is no mode is a usage error that lists the modes", () => {
    expect(errorOf(["--approval", "yolo", "x"])).toBe("--approval must be one of: ask, auto, full")
    expect(errorOf(["--unattended", "wait", "x"])).toBe("--unattended must be one of: deny, stop")
    expect(errorOf(["--approval"])).toBe("--approval needs a value")
    expect(errorOf(["--demo", "1", "--approval", "ask"])).toContain("do not apply to --demo")
  })

  test("the help lists the flags, the modes, the answers and the exit code", () => {
    const help = helpText()
    for (const needle of ["--approval <mode>", "--unattended <what>", "ask   reads run", "auto  edits in the working directory run", "full  everything runs", "/clear-taint", "  4    stopped: a tool call needed your approval"])
      expect(help).toContain(needle)
  })
})

describe("the answer typed at the prompt", () => {
  const choice = (id: "once" | "session" | "project" | "deny") => ({ id, label: id, approve: id !== "deny", remembers: null, grants: [] })
  const question = (ids: ("once" | "session" | "project" | "deny")[]): Question => ({ title: "Allow?", subject: "curl x", details: [], choices: ids.map(choice) })
  const ask = async (entry: string | null, ids: ("once" | "session" | "project" | "deny")[] = ["once", "session", "project", "deny"]) => {
    const prompts: string[] = []
    let interrupted = 0
    const approver = approverAt({ ask: async (text) => (prompts.push(text), entry) }, { interrupt: () => void (interrupted += 1) })
    const answer = await approver({ messageId: "m" as MessageId, callId: "c" as CallId, question: question(ids) })
    return { answer, prompts, interrupted }
  }

  test("the first word picks the choice and the rest is the note", async () => {
    expect((await ask("a")).answer).toEqual({ choice: "once" })
    expect((await ask("y")).answer).toEqual({ choice: "once" })
    expect((await ask("s")).answer).toEqual({ choice: "session" })
    expect((await ask("project")).answer).toEqual({ choice: "project" })
    expect((await ask("n")).answer).toEqual({ choice: "deny" })
    expect((await ask("")).answer).toEqual({ choice: "deny" })
    expect((await ask("a only this once")).answer).toEqual({ choice: "once", note: "only this once" })
    expect((await ask("n use the mirror instead")).answer).toEqual({ choice: "deny", note: "use the mirror instead" })
  })

  test("words that pick nothing decline, and are the note: saying something else is a no with a reason", async () => {
    expect((await ask("use the cached copy")).answer).toEqual({ choice: "deny", note: "use the cached copy" })
  })

  test("the prompt names only the choices the question offers, and a choice it does not offer becomes the one that asks for less", async () => {
    const once = await ask("s", ["once", "deny"])
    expect(once.prompts).toEqual(["[a]llow once · [N]o › "])
    expect(once.answer).toEqual({ choice: "once" })
    expect((await ask("p")).prompts).toEqual(["[a]llow once · this [s]ession · this [p]roject · [N]o › "])
  })

  test("backing out stops the turn instead of answering", async () => {
    const backed = await ask(null)
    expect(backed.answer).toBeNull()
    expect(backed.interrupted).toBe(1)
  })
})

describe("an unattended run", () => {
  /** Runs the real CLI once, with a scripted model, in a workspace of its own. */
  async function run(responses: unknown[][], args: readonly string[]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-cli-approval-")))
    scratch.push(root)
    const workspace = join(root, "work")
    mkdirSync(workspace)
    const script = join(root, "script.json")
    writeFileSync(script, JSON.stringify({ responses }))
    const proc = Bun.spawn(["bun", CLI, "--cwd", workspace, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, XDG_DATA_HOME: join(root, "xdg"), [SCRIPT_ENV]: script } })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { out, err, code, workspace }
  }
  const fetch = [{ type: "tool_call", callId: "c1", name: "shell", input: { command: "curl -s https://example.com > page.html", sandbox: { network: true } } }]

  test("never waits: the call is refused, the output says so and why, and the run goes on to its answer", async () => {
    const result = await run([fetch, [{ type: "text", text: "I could not fetch the page." }]], ["Fetch the page."])
    expect(result.code).toBe(0)
    // Wrapped to the terminal's width; said once, in full.
    expect(result.out.replace(/\n\s+/g, " ")).toContain("○ not run: needs approval for network access for this command; nobody is here to give it, so it was refused (--unattended deny)")
    expect(result.out).toContain("I could not fetch the page.")
    expect(existsSync(join(result.workspace, "page.html"))).toBe(false)
  }, 60_000)

  test("with --unattended stop the run ends with its own exit code, and --json carries the reason in the events", async () => {
    const result = await run([fetch], ["--json", "--unattended", "stop", "Fetch the page."])
    expect(result.code).toBe(EXIT_APPROVAL_REQUIRED)
    const events = result.out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    expect(events.find((item) => item.type === "approval.denied")?.data).toMatchObject({ reason: "unattended", stop: true, needs: [{ kind: "sandbox-network" }] })
    expect(events.at(-1)).toMatchObject({ type: "execution.failed", data: { cause: "approval" } })
  }, 60_000)

  test("-q says on stderr what was refused, and the answer alone on stdout", async () => {
    const result = await run([fetch, [{ type: "text", text: "I could not fetch the page." }]], ["-q", "Fetch the page."])
    expect(result.out).toBe("I could not fetch the page.\n")
    expect(result.err).toContain("a tool call was not run: it needs approval for network access for this command, and nobody is here to give it (--unattended deny)")
  }, 60_000)

  test("--approval full asks nothing and runs the command with the user's own permissions", async () => {
    const result = await run([[{ type: "tool_call", callId: "c1", name: "shell", input: { command: "echo ran > ran.txt" } }], [{ type: "text", text: "Done." }]], ["--json", "--approval", "full", "Run it."])
    expect(result.code).toBe(0)
    const events = result.out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string; data: { run?: unknown } })
    expect(events.find((item) => item.type === "tool.started")?.data.run).toEqual({ mode: "full", origin: "builtin", paths: [], sandbox: null })
    expect(existsSync(join(result.workspace, "ran.txt"))).toBe(true)
  }, 60_000)
})
