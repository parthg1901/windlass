/**
 * The built executable for this machine, run as a user would: from a
 * directory outside the repository, with a clean environment (a temporary
 * HOME and data directory, a PATH without Bun). Skipped, and saying so, when
 * it has not been built: `bun scripts/build.ts` builds it (this test never
 * does, a build takes a while).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import workspace from "../../package.json" with { type: "json" }
import { brand } from "../../packages/core/src/brand.ts"
import { ROOT, artifactName, hostTarget } from "../../scripts/build.ts"

// Each test starts the executable one or more times, and a command starts the server child and a sandboxed shell
// too. On the slowest runner (Intel macOS) one start costs most of a second, so five seconds is not enough.
setDefaultTimeout(30_000)

const host = hostTarget()
const executable = host === null ? null : join(ROOT, "dist", artifactName(host))
const built = executable !== null && existsSync(executable)
if (!built) console.warn(`binary.test.ts: SKIPPED, no executable at ${executable ?? `(no target for ${process.platform}-${process.arch})`}; build it with \`bun scripts/build.ts\``)

// Its real path: the program names its working directory as the system gives it (on macOS /var/folders is /private/var/folders).
const home = realpathSync(mkdtempSync(join(tmpdir(), "release-binary-")))
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

  test("each alias, a link to the executable as the install script makes it, is the same program", async () => {
    const version = await run(["--version"])
    for (const alias of brand.aliases) {
      const link = join(home, alias)
      symlinkSync(executable!, link)
      const as = async (args: readonly string[]) => {
        const child = Bun.spawn([link, ...args], { cwd: work, env: cleanEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { code, out, err }
      }
      expect(await as(["--version"])).toEqual(version)
      // The server child is started from the executable itself, whatever name started it.
      expect(await as(["--list-sessions"])).toEqual({ code: 0, out: `no sessions in ${work}\n`, err: "" })
    }
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
    await Bun.write(join(work, ".env"), `${brand.envPrefix}ACP_SCRIPT=${script}\n`)
    const result = await run(["hello"])
    rmSync(join(work, ".env"))
    expect(result.code).toBe(1)
    expect(result.err).toContain(`${brand.binary} login`)
    expect(result.out).not.toContain("loaded")
    expect(await run(["login", "status"])).toEqual({ code: 1, out: `not signed in; run \`${brand.binary} login\`\n`, err: "" })
  })

  test("a sign-in handed in from outside: login status describes the file, and with no sign-in saved login token has nothing to hand on", async () => {
    const file = join(home, "handed-in-token")
    const env = { [`${brand.envPrefix}ACCESS_TOKEN_FILE`]: file }
    const first = (usable: boolean) =>
      usable
        ? `signed in with the access token handed in through ${brand.envPrefix}ACCESS_TOKEN_FILE (the saved sign-in is not used)`
        : `not signed in: the access token handed in through ${brand.envPrefix}ACCESS_TOKEN_FILE cannot be used (the saved sign-in is not used)`
    const missing = await run(["login", "status"], { env })
    expect([missing.code, missing.err]).toEqual([1, ""])
    expect(missing.out).toStartWith(`${first(false)}\naccess token file: ${file}\n`)
    expect(missing.out).toEndWith("(handed_in_missing)\n")
    await Bun.write(file, `${JSON.stringify({ accessToken: "handed-token-0001", expiresAt: Date.now() + 90 * 60_000 })}\n`)
    const usable = await run(["login", "status"], { env })
    expect([usable.code, usable.err]).toEqual([0, ""])
    expect(usable.out).toMatch(new RegExp(`^${first(true).replace(/[()]/g, "\\$&")}\naccess token file: ${file}\naccess token: valid for (89|90) more minutes; whoever handed it in replaces the file\n$`))
    expect(usable.out).not.toContain("handed-token-0001")
    // A prompt with a token that cannot be used says to hand in a new one, not to sign in here.
    await Bun.write(file, "")
    const prompt = await run(["hello"], { env })
    expect([prompt.code, prompt.out]).toEqual([1, ""])
    expect(prompt.err).toBe(`${brand.binary}: the file ${brand.envPrefix}ACCESS_TOKEN_FILE names is empty (${file}); hand in a new token (the output of \`${brand.binary} login token\`, run where the sign-in is saved), then try again\n`)
    // Handing a token on: nothing is saved in this data directory, and a process on a handed-in token holds none.
    expect(await run(["login", "token"])).toEqual({ code: 1, out: "", err: `${brand.binary}: not signed in, so there is no token to hand on; run \`${brand.binary} login\`\n` })
    const refused = await run(["login", "token", "--json"], { env })
    expect([refused.code, refused.out]).toEqual([1, ""])
    expect(refused.err).toContain(`handed in through ${brand.envPrefix}ACCESS_TOKEN_FILE and holds no sign-in`)
    expect((await run(["login", "--help"])).out).toContain(`${brand.binary} login token`)
  })

  test("a command runs through the scripted model, in the sandbox when this machine has one", async () => {
    const script = join(home, "shell.json")
    await Bun.write(
      script,
      JSON.stringify({ responses: [[{ type: "tool_call", callId: "c1", name: "shell", input: { command: "echo from-inside > made.txt; cat made.txt" } }], [{ type: "text", text: "Ran it." }]] }),
    )
    const result = await run(["run it"], { env: { [`${brand.envPrefix}ACP_SCRIPT`]: script } })
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
