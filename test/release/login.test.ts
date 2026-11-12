/**
 * `windlass login` against a fake authorization server (`fake-auth.ts`) and a
 * temporary data directory, injected through the auth module's configuration.
 * The machine's real sign-in is never read or written.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { CHATGPT_AUTH, credentialsPath, loadCredentials, loadPending, pendingPath } from "../../packages/core/src/auth/chatgpt.ts"
import { helpText, parseArgs } from "../../packages/cli/src/args.ts"
import { type LoginDeps, type LoginIo, runLogin } from "../../packages/cli/src/login.ts"
import { ACCOUNT, type FakeAuth, startFakeAuth } from "./fake-auth.ts"

let auth: FakeAuth | null = null
afterEach(() => {
  auth?.stop()
  auth = null
})

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** Runs `windlass login ...` in-process. `paste` types into a terminal with echo off; `stdin` is a pipe's contents. */
async function login(argv: readonly string[], deps: LoginDeps, input: { paste?: (type: (data: string) => void, out: () => string) => void; stdin?: string } = {}): Promise<Run> {
  let out = ""
  let err = ""
  const io: LoginIo = {
    env: {},
    stdout: { write: (text) => void (out += text) },
    stderr: { write: (text) => void (err += text) },
    stdin: {
      isTTY: input.paste !== undefined,
      readAll: async () => input.stdin ?? "",
      ...(input.paste === undefined
        ? {}
        : {
            listen: (onData: (data: string) => void) => {
              input.paste!(onData, () => out)
              return () => {}
            },
          }),
    },
  }
  const code = await runLogin(argv, io, { port: 0, openBrowser: null, ...deps })
  return { code, out, err }
}

const addressIn = (out: string) => /^ {2}(http\S+)$/m.exec(out)?.[1] ?? ""

describe("parsing", () => {
  test("login and its subcommands reach runLogin; the help lists them", () => {
    for (const argv of [["login"], ["login", "start"], ["login", "finish"], ["login", "status"], ["login", "logout"]]) expect(parseArgs(argv)).toEqual({ kind: "login", argv: argv.slice(1) })
    for (const command of ["login [start]", "login finish", "login status", "login logout"]) expect(helpText()).toContain(`${brand.binary} ${command}`)
  })

  test("the address is never taken from the command line", async () => {
    auth = await startFakeAuth()
    const result = await login(["finish", "http://127.0.0.1:1455/auth/callback?code=x&state=y"], { config: auth.config })
    expect(result.code).toBe(2)
    expect(result.err).toContain("never given on the command line")
    expect((await login(["sideways"], { config: auth.config })).code).toBe(2)
    expect((await login(["start", "--bogus"], { config: auth.config })).err).toContain("unknown option --bogus")
  })

  test("production talks to OpenAI and keeps its files in the data directory", () => {
    expect(CHATGPT_AUTH.issuer).toBe("https://auth.openai.com")
    expect(CHATGPT_AUTH.authorizeUrl).toBe("https://auth.openai.com/api/accounts/authorize")
    expect(CHATGPT_AUTH.tokenUrl).toBe("https://auth.openai.com/api/accounts/oauth/token")
    expect(CHATGPT_AUTH.jwksUrl).toBe("https://auth.openai.com/.well-known/jwks.json")
    expect(credentialsPath()).toEndWith(join(brand.directory, "auth.json"))
  })
})

describe("signing in", () => {
  test("with a browser: it is opened and its return is caught on the loopback port", async () => {
    auth = await startFakeAuth()
    const fake = auth
    const opened: string[] = []
    const result = await login(["start"], {
      config: fake.config,
      openBrowser: async (url) => {
        opened.push(url)
        // The browser follows the redirect to the loopback listener.
        void fetch(await fake.authorize(url))
        return true
      },
    })
    expect(result.code).toBe(0)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.startsWith(fake.config.authorizeUrl)).toBe(true)
    expect(result.out).toContain("in the browser that just opened")
    expect(result.out).toEndWith(`signed in as ${ACCOUNT.email}\n`)
    const saved = await loadCredentials(fake.config)
    expect(saved?.account).toEqual(ACCOUNT)
    expect(statSync(credentialsPath(fake.config)).mode & 0o777).toBe(0o600)
    expect(await loadPending(fake.config)).toBeUndefined()
  })

  test("on a remote machine: the address the browser ended on is pasted with echo off", async () => {
    auth = await startFakeAuth()
    const fake = auth
    let pasted = ""
    const result = await login(["start"], { config: fake.config }, {
      paste: (type, out) => {
        void (async () => {
          while (addressIn(out()) === "") await Bun.sleep(5)
          pasted = await fake.authorize(addressIn(out()))
          // A terminal's bracketed paste, then Enter.
          type(`\x1b[200~${pasted}\x1b[201~`)
          type("\r")
        })()
      },
    })
    expect(result.code).toBe(0)
    expect(result.out).toContain("Address (not shown as you paste): \n")
    expect(pasted).toContain("code=")
    expect(result.out).not.toContain(pasted)
    expect(result.out).toEndWith(`signed in as ${ACCOUNT.email}\n`)
  })

  test("without a terminal or a browser: start prints the address, finish takes it on stdin", async () => {
    auth = await startFakeAuth()
    const started = await login(["start"], { config: auth.config })
    expect(started.code).toBe(0)
    expect(started.out).toContain(`run \`${brand.binary} login finish\``)
    const pending = await loadPending(auth.config)
    expect(pending?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    const status = await login(["status"], { config: auth.config })
    expect(status.code).toBe(1)
    expect(status.out).toContain(`is waiting for \`${brand.binary} login finish\``)
    const callback = await auth.authorize(addressIn(started.out))
    const finished = await login(["finish"], { config: auth.config }, { stdin: `${callback}\n` })
    expect(finished).toEqual({ code: 0, out: `signed in as ${ACCOUNT.email}\n`, err: "" })
  })

  test("status says who and until when, and never prints a token", async () => {
    auth = await startFakeAuth()
    const started = await login(["start"], { config: auth.config })
    await login(["finish"], { config: auth.config }, { stdin: await auth.authorize(addressIn(started.out)) })
    const status = await login(["status"], { config: auth.config })
    expect(status.code).toBe(0)
    expect(status.out).toContain(`signed in as ${ACCOUNT.email}\nplan usage: granted\naccess token: valid for 60 more minutes`)
    expect(status.out).toContain(credentialsPath(auth.config))
    expect(auth.secrets.length).toBe(3)
    for (const secret of auth.secrets) expect(status.out).not.toContain(secret)
  })

  test("logout forgets the sign-in; status then says signed out", async () => {
    auth = await startFakeAuth()
    const started = await login(["start"], { config: auth.config })
    await login(["finish"], { config: auth.config }, { stdin: await auth.authorize(addressIn(started.out)) })
    expect((await login(["logout"], { config: auth.config })).out).toBe(`signed out: the saved sign-in was removed from ${credentialsPath(auth.config)}\n`)
    expect(await Bun.file(credentialsPath(auth.config)).exists()).toBe(false)
    expect(await login(["status"], { config: auth.config })).toEqual({ code: 1, out: `not signed in; run \`${brand.binary} login\`\n`, err: "" })
    expect((await login(["logout"], { config: auth.config })).out).toBe("not signed in; nothing to remove\n")
  })
})

describe("failures", () => {
  test("a callback from another sign-in, a refusal, and finish with nothing pending", async () => {
    auth = await startFakeAuth()
    const started = await login(["start"], { config: auth.config })
    const wrong = (await auth.authorize(addressIn(started.out))).replace(/state=[^&]+/, "state=other")
    const mismatch = await login(["finish"], { config: auth.config }, { stdin: wrong })
    expect(mismatch).toEqual({ code: 1, out: "", err: `${brand.binary}: sign-in failed: The callback does not belong to the sign-in that is in progress. (state_mismatch)\n` })
    const denied = await login(["finish"], { config: auth.config }, { stdin: await auth.authorize(addressIn(started.out), { deny: true }) })
    expect(denied.err).toBe(`${brand.binary}: sign-in failed: Sign-in was not completed (access_denied). (access_denied)\n`)
    rmSync(pendingPath(auth.config))
    const nothing = await login(["finish"], { config: auth.config }, { stdin: "x" })
    expect(nothing.err).toBe(`${brand.binary}: sign-in failed: No sign-in is in progress. Run \`${brand.binary} login\` first. (no_pending_login)\n`)
  })

  test("a sign-in without plan usage is refused and nothing is saved", async () => {
    auth = await startFakeAuth({ scopes: "openid profile email offline_access" })
    const started = await login(["start"], { config: auth.config })
    const result = await login(["finish"], { config: auth.config }, { stdin: await auth.authorize(addressIn(started.out)) })
    expect(result.code).toBe(1)
    expect(result.err).toContain("ChatGPT plan usage was not granted. (plan_usage_not_granted)")
    expect(await loadCredentials(auth.config)).toBeUndefined()
  })

  test("Ctrl-C at the paste prompt abandons the sign-in with exit code 130", async () => {
    auth = await startFakeAuth()
    const result = await login(["start"], { config: auth.config }, { paste: (type) => setTimeout(() => type("\x03"), 10) })
    expect(result.code).toBe(130)
    expect(result.err).toContain(`run \`${brand.binary} login finish\` to paste the address later`)
  })
})
