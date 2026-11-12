/**
 * The default path as a user meets it: the CLI as a real process, with
 * `lh acp` as its child, a scripted model, and a temporary data directory.
 * Ctrl-C, SIGTERM, a closed output pipe, and the server dying under a turn;
 * then a server that is slow to start, exits before it is ready, or speaks
 * something else.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Subprocess } from "bun"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT_ENV } from "@light-harness/acp"
import { brand } from "@light-harness/core"
import { createAcpEngine } from "../src/acp-engine.ts"
import { EngineUnavailable } from "../src/engine.ts"
import { CLI } from "./helpers.ts"

setDefaultTimeout(40_000)

const scratch: string[] = []
const running: Subprocess[] = []
afterEach(() => {
  for (const proc of running.splice(0)) proc.kill("SIGKILL")
})
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true })
})

/** A workspace, a data directory, and scripts for the model, one file per run. */
function place() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-acp-cli-")))
  scratch.push(root)
  const workspace = join(root, "work")
  mkdirSync(workspace)
  let scripts = 0
  return {
    root,
    workspace,
    xdg: join(root, "xdg"),
    script: (responses: unknown[][]) => {
      const file = join(root, `script-${(scripts += 1)}.json`)
      writeFileSync(file, JSON.stringify({ responses }))
      return file
    },
  }
}

type Place = ReturnType<typeof place>

/** The command each test sleeps in: distinct, so that a test can tell whether it still runs. */
const sleeper = () => `sleep 30.${Math.floor(Math.random() * 1e6)}`

function start(at: Place, script: string, args: readonly string[]) {
  const proc = Bun.spawn(["bun", CLI, "--cwd", at.workspace, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, XDG_DATA_HOME: at.xdg, [SCRIPT_ENV]: script },
  })
  running.push(proc)
  const output = { out: "", err: "" }
  const read = async (stream: ReadableStream<Uint8Array>, into: "out" | "err") => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output[into] += decoder.decode(chunk, { stream: true })
  }
  const done = Promise.all([read(proc.stdout, "out"), read(proc.stderr, "err")])
  const waitFor = async (needle: string, timeoutMs = 20_000) => {
    const until = Date.now() + timeoutMs
    while (!output.out.includes(needle)) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(needle)}; output so far:\n${output.out}\n${output.err}`)
      await Bun.sleep(25)
    }
  }
  return { proc, output, done, waitFor }
}

/** The engine server the CLI started: its one child process. */
async function serverOf(pid: number): Promise<number> {
  const listed = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().trim().split("\n").filter((line) => line !== "")
  expect(listed).toHaveLength(1)
  return Number(listed[0])
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const commandRunning = (command: string) => Bun.spawnSync(["pgrep", "-f", command]).stdout.toString().trim() !== ""

async function eventually(check: () => boolean, ms = 10_000, what = "condition"): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

describe("signals reach the CLI, not the server", () => {
  test("Ctrl-C stops the turn (130); the command is stopped, the server leaves, the session opens again", async () => {
    const at = place()
    const command = sleeper()
    const cli = start(at, at.script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command } }]]), ["wait for it"])
    await cli.waitFor(`▸ shell ${command}\n`)
    const server = await serverOf(cli.proc.pid)
    await eventually(() => commandRunning(command), 5000, "the command to start")
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    await cli.done
    expect(cli.output.out).toContain("■ stopping… press Ctrl-C again to exit now\n")
    expect(cli.output.out).toMatch(/✗ shell sleep [\d.]+ · stopped/)
    expect(cli.output.out).toMatch(/\n■ interrupted · [\d.]+m?s\n$/)
    expect(cli.output.err).toBe("")
    await eventually(() => !alive(server), 10_000, "the server to exit")
    expect(commandRunning(command)).toBe(false)
    const again = start(at, at.script([[{ type: "text", text: "Here again." }]]), ["--continue", "--quiet", "hello"])
    expect(await again.proc.exited).toBe(0)
    await again.done
    expect(again.output.out).toBe("Here again.\n")
  })

  test("a second Ctrl-C exits at once; the server shuts the session down on its own and it resumes later", async () => {
    const at = place()
    const command = sleeper()
    const cli = start(at, at.script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command: `trap '' TERM; ${command}` } }]]), ["wait for it"])
    await cli.waitFor("▸ shell trap")
    const server = await serverOf(cli.proc.pid)
    await Bun.sleep(400)
    cli.proc.kill("SIGINT")
    await cli.waitFor("■ stopping")
    const sent = Date.now()
    cli.proc.kill("SIGINT")
    expect(await cli.proc.exited).toBe(130)
    expect(Date.now() - sent).toBeLessThan(3_000)
    await cli.done
    expect(cli.output.out).toContain("exiting without waiting for the stop\n")
    await eventually(() => !alive(server), 15_000, "the server to exit")
    const again = start(at, at.script([[{ type: "text", text: "Here again." }]]), ["--continue", "--quiet", "hello"])
    expect(await again.proc.exited).toBe(0)
    await again.done
    expect(again.output.out).toBe("Here again.\n")
  })

  test("SIGTERM stops the work as a shutdown (143) and the server leaves", async () => {
    const at = place()
    const command = sleeper()
    const cli = start(at, at.script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command } }]]), ["wait for it"])
    await cli.waitFor(`▸ shell ${command}\n`)
    const server = await serverOf(cli.proc.pid)
    await eventually(() => commandRunning(command), 5000, "the command to start")
    cli.proc.kill("SIGTERM")
    expect(await cli.proc.exited).toBe(143)
    await cli.done
    expect(cli.output.out).toContain("■ shutting down")
    await eventually(() => !alive(server), 10_000, "the server to exit")
    expect(commandRunning(command)).toBe(false)
  })

  test("a reader that goes away (| head) ends the run with 141", async () => {
    const at = place()
    const script = at.script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command: "for i in 1 2 3 4 5 6; do echo line $i; sleep 0.3; done" } }], [{ type: "text", text: "Done." }]])
    const proc = Bun.spawn(["bash", "-c", `bun ${CLI} --cwd ${at.workspace} --json "count" | head -1 > /dev/null; echo "code \${PIPESTATUS[0]}"`], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_DATA_HOME: at.xdg, [SCRIPT_ENV]: script },
    })
    running.push(proc)
    expect(await proc.exited).toBe(0)
    expect((await new Response(proc.stdout).text()).trim()).toBe("code 141")
  })
})

describe("the server dies under a turn", () => {
  test("the CLI says so and exits 1; the next run recovers the session through the engine's crash recovery", async () => {
    const at = place()
    const command = sleeper()
    const cli = start(at, at.script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command } }]]), ["wait for it"])
    await cli.waitFor(`▸ shell ${command}\n`)
    const server = await serverOf(cli.proc.pid)
    await eventually(() => commandRunning(command), 5000, "the command to start")
    process.kill(server, "SIGKILL")
    expect(await cli.proc.exited).toBe(1)
    await cli.done
    const said = cli.output.err.trim().split("\n")
    expect(said.at(-1)).toMatch(new RegExp(`^${brand.binary}: the engine process was killed \\(SIGKILL\\) in the middle of the session; its work is recovered when the session is opened again: ${brand.binary} --session ses_[0-9a-f]+$`))
    const id = /--session (ses_[0-9a-f]+)/.exec(cli.output.err)![1]!
    // Nothing is left running in the name of the dead server.
    await eventually(() => !commandRunning(command), 10_000, "the command to be stopped")

    const again = start(at, at.script([[{ type: "text", text: "Picked up again." }]]), ["--session", id, "--json", "carry on"])
    expect(await again.proc.exited).toBe(0)
    await again.done
    const events = again.output.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> })
    // The recovery comes first: the step the dead process left open fails as crashed, and the call it ran is settled.
    const failed = events.find((item) => item.type === "step.failed")
    expect((failed?.data.error as { kind?: string } | undefined)?.kind).toBe("crashed")
    expect(events.findIndex((item) => item.type === "step.failed")).toBeLessThan(events.findIndex((item) => item.type === "inbox.enqueued"))
    expect(events.at(-1)?.type).toBe("execution.succeeded")
  })
})

describe("a server that does not start properly", () => {
  const fixture = (name: string, source: string) => {
    const at = place()
    const file = join(at.root, name)
    writeFileSync(file, source)
    return file
  }
  const open = (engine: ReturnType<typeof createAcpEngine>) =>
    engine.open({ session: { kind: "new" }, cwd: tmpdir(), model: null, effort: null, maxSteps: null }).then(
      () => null,
      (error: unknown) => error,
    )

  test("slow to start: given up on after the start timeout, with a sentence, and stopped", async () => {
    const pidFile = join(place().root, "pid")
    const slow = fixture("slow.ts", `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60_000)`)
    const started = Date.now()
    const refused = await open(createAcpEngine({ command: ["bun", slow], startTimeoutMs: 1500 }))
    expect(refused).toBeInstanceOf(EngineUnavailable)
    expect((refused as Error).message).toBe("the engine process did not start within 1.5 s; giving up")
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = Number(await Bun.file(pidFile).text())
    await eventually(() => !alive(pid), 5000, "the slow server to be stopped")
  })

  test("exits before it is ready: its last words are in the sentence", async () => {
    const broken = fixture("broken.sh", `echo "${brand.binary} acp error: the data directory is not writable" >&2; exit 3`)
    const refused = await open(createAcpEngine({ command: ["sh", broken], stderr: () => {} }))
    expect((refused as Error).message).toBe("the engine could not start: the data directory is not writable (its process exited with code 3)")
  })

  test("dies at start with an uncaught error: one sentence with the error's message, and none of the runtime's dump on stderr", async () => {
    const crashing = fixture("crashing.ts", `throw new Error("cannot open the data directory: permission denied")`)
    const written: string[] = []
    const refused = await open(createAcpEngine({ command: ["bun", crashing], stderr: (text) => void written.push(text) }))
    expect((refused as Error).message).toBe("the engine could not start: cannot open the data directory: permission denied (its process exited with code 1)")
    // Bun's source excerpt, stack and banner went to the server's stderr; the user is not shown them.
    expect(written.join("")).toBe("")
  })

  test("speaks ACP but not this harness's events: refused as another version", async () => {
    const sdk = new URL("../node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js", import.meta.url).pathname
    const other = fixture(
      "other-agent.ts",
      `import { agent, methods, ndJsonStream } from ${JSON.stringify(sdk)}
const output = new WritableStream({ write: (chunk) => void process.stdout.write(chunk) })
agent({ name: "other" }).onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} })).connect(ndJsonStream(output, Bun.stdin.stream()))`,
    )
    const refused = await open(createAcpEngine({ command: ["bun", other] }))
    expect((refused as Error).message).toBe(`the engine process does not send ${brand.name}'s events (${brand.extensionPrefix}/event); it may be another version`)
  })

  test("writes something that is not the protocol: given up on with a sentence", async () => {
    const noise = fixture("noise.sh", "echo 'hello, I am not a protocol'; sleep 30")
    const refused = await open(createAcpEngine({ command: ["sh", noise], startTimeoutMs: 1500 }))
    expect(refused).toBeInstanceOf(EngineUnavailable)
    expect((refused as Error).message).toMatch(/^the engine process (did not start within 1\.5 s; giving up|did not answer as expected: .+)$/)
  })
})
