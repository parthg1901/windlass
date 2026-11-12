/**
 * `fork` and `replay` as a user runs them: the CLI as a real process with
 * `lh acp` as its child, a scripted model (each process plays its script
 * from the start) and a temporary data directory. A fork is listed and can
 * be continued with `--session`; a replay of a scripted recording prints
 * its progress and the report.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCRIPT_ENV } from "@light-harness/acp"
import { brand } from "@light-harness/core"
import { parseArgs } from "../src/args.ts"
import { CLI } from "./helpers.ts"

setDefaultTimeout(60_000)

const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-cli-fork-")))
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

async function cli(at: ReturnType<typeof place>, responses: unknown[][], args: readonly string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: at.workspace,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, XDG_DATA_HOME: at.xdg, [SCRIPT_ENV]: script(responses), NO_COLOR: "1" },
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

    const missing = await cli(at, [], ["fork", "ses_nothing"])
    expect(missing.code).toBe(1)
    expect(missing.err).toStartWith(`${brand.binary}: `)
    expect(missing.err).toContain("ses_nothing")
  })

  test("replay: progress on stderr, the report on stdout; a changed call is where it diverged; exit 0 when it ran", async () => {
    const at = place("replay")
    expect((await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["write b"])).code).toBe(0)
    const same = await cli(at, [[write("bee\n")], [say("Wrote b.txt.")]], ["replay"])
    expect(same.code).toBe(0)
    expect(same.err).toMatch(/^replaying ses_[0-9a-f]+ as ses_[0-9a-f]+\n {2}step 1 · write b\.txt · as recorded\n$/)
    expect(same.out).toMatch(/^replay ses_[0-9a-f]+: IDENTICAL {2}all 2 recorded steps replayed without a divergence/)
    expect(same.out).toContain("(2 model calls)")
    expect(readFileSync(join(at.workspace, "b.txt"), "utf8")).toBe("bee\n")

    const changed = await cli(at, [[write("BEE\n")], [say("Wrote.")]], ["replay", "--json"])
    expect(changed.code).toBe(0)
    expect(changed.err).toBe("")
    const result = JSON.parse(changed.out) as { report: { status: string; divergence: { kind: string } }; policy: string }
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
