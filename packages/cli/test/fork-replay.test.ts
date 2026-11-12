/**
 * `fork` and `replay` as a user runs them: the CLI as a real process with
 * `windlass acp` as its child, a scripted model (each process plays its script
 * from the start) and a temporary data directory. A fork is listed and can
 * be continued with `--session`; a replay of a scripted recording prints
 * its progress and the report.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT_ENV, scriptedProvider } from "@windlass/acp"
import { brand } from "@windlass/core"
import { parseArgs } from "../src/args.ts"
import { FakeProvider } from "@windlass/core/testing"
import { createAcpEngine } from "../src/acp-engine.ts"
import { CLI, runCli } from "./helpers.ts"

setDefaultTimeout(60_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-cli-fork-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let scripts = 0
function script(responses: unknown[][]): string {
  const file = join(root, `script-${(scripts += 1)}.json`)
  writeFileSync(file, JSON.stringify({ responses }))
  return file
}

function place(name: string) {
  const workspace = join(root, name, "work")
  mkdirSync(workspace, { recursive: true })
  return { workspace, xdg: join(root, name, "xdg") }
}

/** `responses: null`: no scripted model, so the server reads the sign-in of the throwaway data directory, which has none. */
async function cli(at: ReturnType<typeof place>, responses: unknown[][] | null, args: readonly string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: at.workspace,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, XDG_DATA_HOME: at.xdg, [SCRIPT_ENV]: responses === null ? "" : script(responses), NO_COLOR: "1" },
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out, err, code }
}

const write = (content: string) => ({ type: "tool_call", callId: "c1", name: "write", input: { path: "b.txt", content } })
const say = (text: string) => ({ type: "text", text })
const sessionIds = (text: string) => [...text.matchAll(/ses_[0-9a-f]+/g)].map((match) => match[0])

describe("parsing", () => {
  test("fork and replay take one session and their own options; mistakes are usage errors", () => {
    expect(parseArgs(["fork"])).toMatchObject({ kind: "fork", options: { session: null, copy: null, throughSeq: null } })
    expect(parseArgs(["fork", "ses_ab", "--copy", "--through", "12", "-m", "m2", "--title", "Other way"])).toMatchObject({
      kind: "fork",
      options: { session: "ses_ab", copy: { copyTo: null }, throughSeq: 12, model: "m2", title: "Other way" },
    })
    expect(parseArgs(["fork", "--copy-to", "/var/tmp/x"])).toMatchObject({ options: { copy: { copyTo: "/var/tmp/x" } } })
    expect(parseArgs(["fork", "--copy-to", "rel"])).toEqual({ kind: "error", message: "fork: --copy-to takes an absolute path" })
    expect(parseArgs(["fork", "a", "b"])).toMatchObject({ kind: "error" })
    expect(parseArgs(["fork", "--through", "x"])).toMatchObject({ kind: "error", message: "fork: --through takes an event number, such as 12" })
    expect(parseArgs(["replay", "ses_ab", "--policy", "execute", "--tool-description", "read=r.md", "--strict", "--effort", "default"])).toMatchObject({
      kind: "replay",
      options: { session: "ses_ab", policy: "execute", toolDescriptions: [{ tool: "read", file: "r.md" }], strict: true, effort: "default" },
    })
    expect(parseArgs(["replay", "--policy", "all"])).toMatchObject({ kind: "error" })
    expect(parseArgs(["replay", "--tool-description", "read"])).toMatchObject({ kind: "error" })
    expect(parseArgs(["replay", "--bogus"])).toMatchObject({ kind: "error" })
    expect(parseArgs(["fork", "--help"])).toMatchObject({ kind: "usage" })
  })
})

describe("as a process", () => {
  test("fork: the new session is listed, says how to continue, and continues with the conversation so far", async () => {
    const at = place("fork")
    const first = await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["write b"])
    expect(first.code).toBe(0)
    const forked = await cli(at, [], ["fork"])
    expect(forked.err).toBe("")
    expect(forked.code).toBe(0)
    const [parent, child] = sessionIds(forked.out)
    expect(forked.out).toStartWith(`Forked ${parent} after its latest step.\nNew session: ${child} "write b (fork)"`)
    expect(forked.out).toContain(`It works in the same directory as the original, ${at.workspace}`)
    expect(forked.out).toContain(`  ${brand.binary} --session ${child} "<your next message>"`)

    const listed = await cli(at, [], ["--list-sessions"])
    expect(listed.out.split("\n").filter((line) => line !== "").map((line) => [sessionIds(line)[0], line.endsWith("write b (fork)")])).toEqual([
      [child, true],
      [parent, false],
    ])
    const continued = await cli(at, [[say("Still here.")]], ["--session", child!, "--json", "what did you write?"])
    expect(continued.code).toBe(0)
    const events = continued.out.trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { text?: string } })
    expect(events.find((item) => item.type === "text.ended")?.data?.text).toBe("Still here.")

    const json = await cli(at, [], ["fork", parent!.slice(0, 10), "--copy", "--json"])
    const copy = JSON.parse(json.out) as { sessionId: string; cwd: string; copiedFrom: string }
    expect(copy.copiedFrom).toBe(at.workspace)
    expect(readFileSync(join(copy.cwd, "b.txt"), "utf8")).toBe("bee\n")

    // A copy says what it holds and lacks, so a failing check there is not a mystery.
    const pretty = await cli(at, [], ["fork", parent!, "--copy"])
    expect(pretty.out).toContain("It works in a copy of")
    expect(pretty.out).toContain("no ignored files (such as node_modules or build output)")
    expect(pretty.out).toContain("so it is not a git repository")

    // The start of an ID without `ses_`; the listing narrowed to the sessions that start so.
    const hex = await cli(at, [], ["fork", parent!.slice(4, 14), "--json"])
    expect((JSON.parse(hex.out) as { parentSessionId: string }).parentSessionId).toBe(parent!)
    const narrowed = await cli(at, [], ["--list-sessions", "--session", parent!.slice(4, 14)])
    expect(narrowed.out.trim().split("\n").map((line) => sessionIds(line)[0])).toEqual([parent])
    const none = await cli(at, [], ["--list-sessions", "--session", "ffffffffff"])
    expect(none.out).toBe(`no session in ${at.workspace} starts with ses_ffffffffff\n`)

    const missing = await cli(at, [], ["fork", "ses_nothing"])
    expect(missing.code).toBe(1)
    expect(missing.err).toStartWith(`${brand.binary}: `)
    expect(missing.err).toContain("ses_nothing")
  })

  test("fork --turn: after a turn as the user counts them; a turn there is not lists the turns", async () => {
    const at = place("by-turn")
    expect((await cli(at, [[write("one\n")], [say("Wrote it.")]], ["write b"])).code).toBe(0)
    expect((await cli(at, [[say("Fine.")]], ["-c", "now check it"])).code).toBe(0)
    const forked = await cli(at, [], ["fork", "--turn", "1", "--json"])
    expect([forked.code, forked.err]).toEqual([0, ""])
    const result = JSON.parse(forked.out) as { sessionId: string; parentSessionId: string; throughSeq: number }
    // The fork holds the first turn and nothing of the second.
    const continued = await cli(at, [[say("Here.")]], ["--session", result.sessionId, "--json", "and?"])
    const prompts = continued.out.split("\n").filter((line) => line.includes('"inbox.enqueued"'))
    expect(prompts).toHaveLength(1)
    // The fork is now the latest session here: the original is named.
    const pretty = await cli(at, [], ["fork", result.parentSessionId, "--turn", "2"])
    expect(pretty.out).toMatch(/^Forked ses_\w+ after turn 2 \(event \d+\)\./)
    // A fork of the fork after a turn the fork inherited is made from the session that turn belongs to: that one is printed.
    const again = await cli(at, [], ["fork", result.sessionId, "--turn", "1"])
    expect(again.err).toBe("")
    expect(again.out).toStartWith(`Forked ${result.parentSessionId} after turn 1 (event ${result.throughSeq}).\n${result.sessionId} is a fork itself and inherited that point from ${result.parentSessionId}, so the new session is a fork of ${result.parentSessionId}.\nNew session: `)
    expect(JSON.parse((await cli(at, [], ["fork", result.sessionId, "--turn", "1", "--json"])).out)).toMatchObject({ parentSessionId: result.parentSessionId, throughSeq: result.throughSeq })
    // After a turn of its own, the fork itself is what was forked.
    expect((await cli(at, [], ["fork", result.sessionId, "--turn", "2"])).out).toStartWith(`Forked ${result.sessionId} after turn 2 `)
    const missing = await cli(at, [], ["fork", result.parentSessionId, "--turn", "7"])
    expect(missing.code).toBe(2)
    expect(missing.err).toBe(`${brand.binary}: there is no turn 7: the session has turns 1 to 2\nIts turns:\n  1  "write b"\n  2  "now check it"\n`)
    expect(parseArgs(["fork", "--turn", "1", "--through", "3"])).toMatchObject({ kind: "error" })
    expect(parseArgs(["fork", "--turn", "x"])).toEqual({ kind: "error", message: "fork: --turn takes a turn number, such as 3" })
  })

  test("signed out: forking and listing work, as they call no model; --models and a prompt say how to sign in", async () => {
    const at = place("signed-out")
    expect((await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["write b"])).code).toBe(0)
    const forked = await cli(at, null, ["fork"])
    expect([forked.code, forked.err]).toEqual([0, ""])
    expect(forked.out).toStartWith("Forked ses_")
    const listed = await cli(at, null, ["--list-sessions"])
    expect([listed.code, listed.out.trim().split("\n").length]).toEqual([0, 2])
    // Without a sign-in the models cannot be listed: one sentence and the way to sign in, never a stack trace.
    for (const args of [["--models"], ["--models", "--json"]]) {
      const models = await cli(at, null, args)
      expect(models).toEqual({ code: 1, out: "", err: `${brand.binary}: not signed in, so the models cannot be listed (they come from your ChatGPT plan); run \`${brand.binary} login\` to sign in with ChatGPT, then try again\n` })
    }
    const prompt = await cli(at, null, ["-c", "and now?"])
    expect(prompt).toEqual({ code: 1, out: "", err: `${brand.binary}: not signed in; run \`${brand.binary} login\` to sign in with ChatGPT, then try again\n` })
  })


  test("replay: progress on stderr, the report on stdout; a changed call is where it diverged; exit 0 when it ran", async () => {
    const at = place("replay")
    expect((await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["write b"])).code).toBe(0)
    const same = await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["replay"])
    expect(same.code).toBe(0)
    expect(same.err).toMatch(/^replaying ses_[0-9a-f]+ as ses_[0-9a-f]+\n {2}step 1 · write b\.txt · as recorded\n$/)
    expect(same.out).toMatch(/^replay ses_[0-9a-f]+: IDENTICAL {2}all 2 recorded steps replayed without a divergence/)
    expect(same.out).toContain("(2 model calls)")
    // The comparison that carries the signal, as scripts/replay.ts prints it.
    expect(same.out).toContain("compared on what it did (reads ignored)")
    expect(same.out).toContain("  side effects   ")
    expect(same.out).toContain("  files          ")
    expect(readFileSync(join(at.workspace, "b.txt"), "utf8")).toBe("bee\n")

    const changed = await cli(at, [[write("BEE\n")], [say("Wrote.")]], ["replay", "--json"])
    expect(changed.code).toBe(0)
    expect(changed.err).toBe("")
    const result = JSON.parse(changed.out) as { report: { status: string; divergence: { kind: string } }; policy: string; compared: { sameWorkspace: unknown } | null }
    expect(result.compared).not.toBeNull()
    expect(result.report.status).toBe("diverged")
    expect(result.report.divergence.kind).toBe("arguments_differ")
    expect(result.policy).toBe("stop")
    // Under `stop` nothing ran.
    expect(readFileSync(join(at.workspace, "b.txt"), "utf8")).toBe("bee\n")

    const usage = await cli(at, [], ["replay", "--system-prompt", join(at.workspace, "missing.md")])
    expect(usage.code).toBe(2)
    expect(usage.err).toContain("--system-prompt")
    expect(usage.err).toContain("no such file")
  })
})

describe("fork --turn after a queued message", () => {
  test("a turn that a queued message followed is forked at the step boundary before the handover", async () => {
    const at = place("queued")
    const scriptFile = script([[{ type: "tool_call", callId: "c1", name: "shell", input: { command: "sleep 0.3" } }], [say("Slept.")], [say("And the second.")]])
    const harness = async () => ({ dataDir: join(at.xdg, brand.directory), provider: await scriptedProvider(scriptFile), log: () => {} })
    // One session, two turns in one execution: the second message is queued while the first turn's command runs.
    const engine = createAcpEngine({ transport: "memory", harness: await harness() })
    const session = await engine.open({ session: { kind: "new" }, cwd: at.workspace, model: null, effort: null, agent: null, maxSteps: null, approval: "full", unattended: null, attended: false })
    await session.send("sleep a little")
    let queued = false
    const seen: string[] = []
    for await (const item of session.events) {
      seen.push(item.type)
      if (item.type === "tool.started" && !queued) {
        queued = true
        await session.send("then say more", { delivery: "queue" })
      }
      if (item.type === "execution.succeeded") break
    }
    await session.close()
    expect(seen.filter((type) => type === "turn.ended" || type === "execution.succeeded")).toEqual(["turn.ended", "execution.succeeded"])

    const made: string[] = []
    for (const turn of ["1", "2"]) {
      const forkEngine = createAcpEngine({ transport: "memory", harness: await harness() })
      const forked = await runCli(["fork", session.id, "--turn", turn, "--cwd", at.workspace, "--json"], { engine: () => forkEngine })
      expect([turn, forked.code, forked.err]).toEqual([turn, 0, ""])
      made.push((JSON.parse(forked.out) as { sessionId: string }).sessionId)
    }
    // The fork after turn 1 holds the first message only; the one after turn 2 holds both.
    const prompts: number[] = []
    for (const id of made) {
      const reader = createAcpEngine({ transport: "memory", harness: { dataDir: join(at.xdg, brand.directory), provider: new FakeProvider([]), log: () => {} } })
      const opened = await reader.open({ session: { kind: "resume", id }, cwd: at.workspace, model: null, effort: null, agent: null, maxSteps: null, approval: null, unattended: null, attended: false })
      prompts.push((await opened.describe!()).turns)
      await opened.close()
    }
    expect(prompts).toEqual([1, 2])
  })
})

describe("usage errors the engine finds", () => {
  test("an unknown model exits 2, as a mistyped option does, and names the models there are", async () => {
    const at = place("unknown-model")
    const engine = () => createAcpEngine({ transport: "memory", harness: { dataDir: join(at.xdg, brand.directory), provider: new FakeProvider([]), log: () => {}, engine: { listModels: async () => ["test-model"] } } })
    const run = await runCli(["--cwd", at.workspace, "-m", "no-such-model", "hello"], { engine })
    expect(run.code).toBe(2)
    expect(run.err).toStartWith(`${brand.binary}: `)
    expect(run.err).toContain("no-such-model")
    expect(run.err).toContain("test-model")
  })
})
