/**
 * The built executable for this machine, run as a user would: from a
 * directory outside the repository, with a clean environment (a temporary
 * HOME and data directory, a PATH without Bun). Skipped, and saying so, when
 * it has not been built: `bun scripts/build.ts` builds it (this test never
 * does, a build takes a while).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import workspace from "../../package.json" with { type: "json" }
import { brand } from "../../packages/core/src/brand.ts"
import { ROOT, artifactName, hostTarget } from "../../scripts/build.ts"

const host = hostTarget()
const executable = host === null ? null : join(ROOT, "dist", artifactName(host))
const built = executable !== null && existsSync(executable)
if (!built) console.warn(`binary.test.ts: SKIPPED, no executable at ${executable ?? `(no target for ${process.platform}-${process.arch})`}; build it with \`bun scripts/build.ts\``)

const home = mkdtempSync(join(tmpdir(), "release-binary-"))
const work = join(home, "work")
mkdirSync(work)
afterAll(() => rmSync(home, { recursive: true, force: true }))

const cleanEnv = (extra: Record<string, string> = {}) => ({ HOME: home, PATH: "/usr/bin:/bin", XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), TERM: "dumb", ...extra })

async function run(args: readonly string[], options: { stdin?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([executable!, ...args], { cwd: work, env: cleanEnv(options.env), stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, out, err }
}

describe.skipIf(!built)(`the built executable (${host?.id ?? "none"})`, () => {
  test("--version and --help", async () => {
    const version = await run(["--version"])
    expect(version.code).toBe(0)
    expect(version.out).toMatch(new RegExp(`^${brand.name} ${workspace.version.replaceAll(".", "\\.")}\\+[0-9a-f]{10}(\\.dirty)? \\(${process.platform}-${process.arch}(, without the full-screen interface)?\\)\\n$`))
    const help = await run(["--help"])
    expect(help.code).toBe(0)
    expect(help.out).toContain(`${brand.binary} [options] <prompt...>`)
    expect(help.out).toContain(`${brand.binary} login status`)
  })

  test("a demo plays without a sign-in or a model", async () => {
    expect((await run(["--demo", "list"])).out).toContain("find-and-fix-a-failing-test")
    const played = await run(["--demo", "a-plain-answer", "--demo-speed", "0"])
    expect(played.code).toBe(0)
    expect(played.out).toContain("✓ done")
  })

  test("acp answers initialize with the same version", async () => {
    const version = (await run(["--version"])).out.split(" ")[1] ?? ""
    const request = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "release-test", version: "1" } } }
    const child = Bun.spawn([executable!, "acp"], { cwd: work, env: cleanEnv(), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    child.stdin.write(`${JSON.stringify(request)}\n`)
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let text = ""
    while (!text.includes("\n")) text += (await reader.read()).value ?? ""
    child.stdin.end()
    expect(await child.exited).toBe(0)
    const answer = JSON.parse(text.split("\n")[0]!) as { result: { agentInfo: { name: string; title: string; version: string } } }
    expect(answer.result.agentInfo).toEqual({ name: brand.binary, title: brand.name, version })
  })

  test("the server child starts from the executable: an empty data directory lists no sessions", async () => {
    expect(await run(["--list-sessions"])).toEqual({ code: 0, out: `no sessions in ${work}\n`, err: "" })
  })

  test("signed out: a prompt says how to sign in, and a project's .env is not loaded", async () => {
    // Were .env read, the scripted model would answer instead of the sign-in error.
    const script = join(home, "script.json")
    await Bun.write(script, JSON.stringify({ responses: [[{ type: "text", text: "loaded" }]] }))
    await Bun.write(join(work, ".env"), `${brand.binary.toUpperCase()}_ACP_SCRIPT=${script}\n`)
    const result = await run(["hello"])
    rmSync(join(work, ".env"))
    expect(result.code).toBe(1)
    expect(result.err).toContain(`${brand.binary} login`)
    expect(result.out).not.toContain("loaded")
    expect(await run(["login", "status"])).toEqual({ code: 1, out: `not signed in; run \`${brand.binary} login\`\n`, err: "" })
  })

  test("a command runs through the scripted model, in the sandbox when this machine has one", async () => {
    const script = join(home, "shell.json")
    await Bun.write(
      script,
      JSON.stringify({ responses: [[{ type: "tool_call", callId: "c1", name: "shell", input: { command: "echo from-inside > made.txt; cat made.txt" } }], [{ type: "text", text: "Ran it." }]] }),
    )
    const result = await run(["run it"], { env: { [`${brand.binary.toUpperCase()}_ACP_SCRIPT`]: script } })
    expect(result.code).toBe(0)
    expect(result.out).toContain("Ran it.")
    // With a sandbox it ran (marked ⊡); without one it asked, and with nobody there it was refused.
    expect(result.out.includes("⊡") ? existsSync(join(work, "made.txt")) : result.out.includes("nobody is")).toBe(true)
  })

  test("tui without a terminal says so", async () => {
    const result = await run(["tui", "--demo", "a-plain-answer"])
    expect(result.code === 2 ? result.err : `${result.code} ${result.err}`).toMatch(/needs a terminal|not part of this build/)
  })
})
