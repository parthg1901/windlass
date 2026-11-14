/**
 * `windlass login` against a fake authorization server (`fake-auth.ts`) and a
 * temporary data directory, injected through the auth module's configuration.
 * The machine's real sign-in is never read or written.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"
import { waitFor } from "../../packages/core/src/testing/wait.ts"
import { ACCESS_TOKEN_FILE_ENV, CHATGPT_AUTH, HAND_IN_ADVICE, credentialsPath, loadCredentials, loadPending, pendingPath } from "../../packages/core/src/auth/chatgpt.ts"
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

/** Runs `windlass login ...` in-process. `paste` types into a terminal with echo off; `stdin` is a pipe's contents; `env` is the process's environment. */
async function login(argv: readonly string[], deps: LoginDeps, input: { paste?: (type: (data: string) => void, out: () => string) => void; stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
  let out = ""
  let err = ""
  const io: LoginIo = {
    env: input.env ?? {},
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
    for (const argv of [["login"], ["login", "start"], ["login", "finish"], ["login", "status"], ["login", "token"], ["login", "token", "--json"], ["login", "logout"]]) expect(parseArgs(argv)).toEqual({ kind: "login", argv: argv.slice(1) })
    for (const command of ["login [start]", "login finish", "login status", "login token [--json]", "login logout"]) expect(helpText()).toContain(`${brand.binary} ${command}`)
    // The one command that prints a token says what it is for and that its output is a secret.
    const token = helpText().slice(helpText().indexOf(`${brand.binary} login token`), helpText().indexOf(`${brand.binary} login logout`))
    expect(token.replace(/\s+/g, " ")).toContain(`print an access token of the saved sign-in (a secret) for another ${brand.name} that cannot share this data directory: it reads the token from the file ${ACCESS_TOKEN_FILE_ENV} names`)
  })

  test("the address is never taken from the command line", async () => {
    auth = await startFakeAuth()
    const result = await login(["finish", "http://127.0.0.1:1455/auth/callback?code=x&state=y"], { config: auth.config })
    expect(result.code).toBe(2)
    expect(result.err).toContain("never given on the command line")
    expect((await login(["sideways"], { config: auth.config })).code).toBe(2)
    expect((await login(["start", "--bogus"], { config: auth.config })).err).toContain("unknown option --bogus")
    // `--json` is `token`'s alone, and `token` takes nothing else.
    expect((await login(["status", "--json"], { config: auth.config })).err).toContain("unknown option --json")
    expect((await login(["token", "--bogus"], { config: auth.config })).code).toBe(2)
    expect((await login(["token", "somewhere"], { config: auth.config })).code).toBe(2)
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
          await waitFor(() => addressIn(out()) !== "", { intervalMs: 5, what: "the sign-in address" })
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

/** Signs in against the fake server; the saved sign-in is then fresh for an hour. */
async function signIn(fake: FakeAuth) {
  const started = await login(["start"], { config: fake.config })
  await login(["finish"], { config: fake.config }, { stdin: await fake.authorize(addressIn(started.out)) })
  return (await loadCredentials(fake.config))!
}

/** Makes the saved access token due for its refresh, as it is a few minutes before it expires. */
function makeDue(fake: FakeAuth) {
  const path = credentialsPath(fake.config)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), expiresAt: Date.now() + 60_000 }))
}

describe("handing a token on", () => {
  test("login token prints the saved sign-in's access token and nothing else; --json adds its expiry, on one line", async () => {
    auth = await startFakeAuth()
    const saved = await signIn(auth)
    expect(await login(["token"], { config: auth.config })).toEqual({ code: 0, out: `${saved.accessToken}\n`, err: "" })
    const json = await login(["token", "--json"], { config: auth.config })
    expect(json).toEqual({ code: 0, out: `${JSON.stringify({ accessToken: saved.accessToken, expiresAt: saved.expiresAt })}\n`, err: "" })
    expect(Object.keys(JSON.parse(json.out))).toEqual(["accessToken", "expiresAt"])
    // Nothing but the access token leaves: not the refresh token, not the ID token.
    for (const secret of [saved.refreshToken, saved.idToken]) expect(json.out).not.toContain(secret)
    // Fresh, so it was handed on as it is: the sign-in was the only token request.
    expect(auth.requests()).toEqual({ token: 1, refreshes: 0 })
  })

  test("a token that is due is refreshed first, once, under the lock, and saved: what is handed on is what a model call here would use", async () => {
    auth = await startFakeAuth()
    const old = await signIn(auth)
    makeDue(auth)
    const json = await login(["token", "--json"], { config: auth.config })
    expect([json.code, json.err]).toEqual([0, ""])
    const handed = JSON.parse(json.out) as { accessToken: string; expiresAt: number }
    const saved = (await loadCredentials(auth.config))!
    expect(handed).toEqual({ accessToken: saved.accessToken, expiresAt: saved.expiresAt })
    expect(handed.accessToken).not.toBe(old.accessToken)
    expect(saved.refreshToken).not.toBe(old.refreshToken)
    expect(handed.expiresAt).toBeGreaterThan(Date.now() + 3_000_000)
    expect(existsSync(join(auth.dir, "auth.lock"))).toBe(true)
    // Asked again, the same token: the refresh happened once.
    expect((await login(["token"], { config: auth.config })).out).toBe(`${handed.accessToken}\n`)
    expect(auth.requests().refreshes).toBe(1)
  })

  test("refused with exit code 1 when not signed in, and when this process itself runs on a handed-in token", async () => {
    auth = await startFakeAuth()
    for (const argv of [["token"], ["token", "--json"]])
      expect(await login(argv, { config: auth.config })).toEqual({ code: 1, out: "", err: `${brand.binary}: not signed in, so there is no token to hand on; run \`${brand.binary} login\`\n` })
    // Signed in, and due for a refresh: with a handed-in token this process holds nothing to hand on, and touches nothing.
    await signIn(auth)
    makeDue(auth)
    const before = readFileSync(credentialsPath(auth.config), "utf8")
    const file = join(auth.dir, "handed-in-token")
    writeFileSync(file, "handed-token-0001\n")
    for (const argv of [["token"], ["token", "--json"]])
      expect(await login(argv, { config: auth.config }, { env: { [ACCESS_TOKEN_FILE_ENV]: file } })).toEqual({
        code: 1,
        out: "",
        err: `${brand.binary}: no token to hand on: this process uses the access token handed in through ${ACCESS_TOKEN_FILE_ENV} and holds no sign-in; run \`${brand.binary} login token\` where the sign-in is saved\n`,
      })
    expect(auth.requests().refreshes).toBe(0)
    expect(readFileSync(credentialsPath(auth.config), "utf8")).toBe(before)
  })

  test("a refresh that is refused fails with the reason, and prints no token", async () => {
    auth = await startFakeAuth()
    const saved = await signIn(auth)
    const path = credentialsPath(auth.config)
    writeFileSync(path, JSON.stringify({ ...saved, refreshToken: "refresh-revoked", expiresAt: Date.now() + 60_000 }))
    const result = await login(["token"], { config: auth.config })
    expect([result.code, result.out]).toEqual([1, ""])
    expect(result.err).toBe(`${brand.binary}: sign-in failed: Token request failed (400 invalid_grant): the refresh token was already used or is not known (invalid_grant)\n`)
  })
})

describe("a sign-in handed in from outside", () => {
  const NOW = Date.UTC(2026, 10, 12, 9, 0, 0)
  const first = (usable: boolean) =>
    usable
      ? `signed in with the access token handed in through ${ACCESS_TOKEN_FILE_ENV} (the saved sign-in is not used)`
      : `not signed in: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} cannot be used (the saved sign-in is not used)`

  test("status says it is handed in through the variable, the file, the expiry when the file states one, and never the token", async () => {
    auth = await startFakeAuth()
    const file = join(auth.dir, "handed-in-token")
    const status = () => login(["status"], { config: auth!.config, now: () => NOW }, { env: { [ACCESS_TOKEN_FILE_ENV]: file } })
    writeFileSync(file, "handed-token-0001\n")
    expect(await status()).toEqual({ code: 0, out: `${first(true)}\naccess token file: ${file}\naccess token: the file states no expiry\n`, err: "" })
    writeFileSync(file, JSON.stringify({ accessToken: "handed-token-0002", expiresAt: NOW + 42 * 60_000 }))
    expect(await status()).toEqual({ code: 0, out: `${first(true)}\naccess token file: ${file}\naccess token: valid for 42 more minutes; whoever handed it in replaces the file\n`, err: "" })
  })

  test("status exits 1 with the reason and its code when the file gives no usable token", async () => {
    auth = await startFakeAuth()
    const file = join(auth.dir, "handed-in-token")
    const status = () => login(["status"], { config: auth!.config, now: () => NOW }, { env: { [ACCESS_TOKEN_FILE_ENV]: file } })
    const unusable = (...lines: string[]) => ({ code: 1, out: `${[first(false), `access token file: ${file}`, ...lines].join("\n")}\n`, err: "" })
    expect(await status()).toEqual(unusable(`The file ${ACCESS_TOKEN_FILE_ENV} names does not exist (${file}). ${HAND_IN_ADVICE} (handed_in_missing)`))
    writeFileSync(file, "\n")
    expect(await status()).toEqual(unusable(`The file ${ACCESS_TOKEN_FILE_ENV} names is empty (${file}). ${HAND_IN_ADVICE} (handed_in_empty)`))
    writeFileSync(file, '{"accessToken": "handed-token-0003"}')
    const malformed = await status()
    expect(malformed).toEqual(unusable(`The file ${ACCESS_TOKEN_FILE_ENV} names holds neither an access token nor what \`${brand.binary} login token --json\` prints (${file}). ${HAND_IN_ADVICE} (handed_in_malformed)`))
    writeFileSync(file, JSON.stringify({ accessToken: "handed-token-0003", expiresAt: NOW - 12 * 60_000 }))
    const expired = await status()
    expect(expired).toEqual(
      unusable("access token: expired 12 minutes ago; whoever handed it in replaces the file", `The access token handed in through ${ACCESS_TOKEN_FILE_ENV} expired at 2026-11-12T08:48:00.000Z (${file}). ${HAND_IN_ADVICE} (handed_in_expired)`),
    )
    for (const result of [malformed, expired]) expect(result.out).not.toContain("handed-token-0003")
    rmSync(file)
    mkdirSync(file)
    expect(await status()).toEqual(unusable(`The file ${ACCESS_TOKEN_FILE_ENV} names cannot be read: EISDIR (${file}). ${HAND_IN_ADVICE} (handed_in_unreadable)`))
  })

  test("status describes the handed-in token even when a sign-in is saved here, and reads nothing of it", async () => {
    auth = await startFakeAuth()
    await signIn(auth)
    const file = join(auth.dir, "handed-in-token")
    writeFileSync(file, "handed-token-0001")
    const status = await login(["status"], { config: auth.config }, { env: { [ACCESS_TOKEN_FILE_ENV]: file } })
    expect(status.code).toBe(0)
    expect(status.out).not.toContain(ACCOUNT.email)
    expect(status.out).not.toContain("handed-token-0001")
    for (const secret of auth.secrets) expect(status.out).not.toContain(secret)
    // An empty variable is no variable: the saved sign-in is what status describes.
    expect((await login(["status"], { config: auth.config }, { env: { [ACCESS_TOKEN_FILE_ENV]: "" } })).out).toStartWith(`signed in as ${ACCOUNT.email}\n`)
  })

  test("start, finish and logout still act on the saved sign-in, and say in one line that this process uses a handed-in token", async () => {
    auth = await startFakeAuth()
    const env = { [ACCESS_TOKEN_FILE_ENV]: join(auth.dir, "handed-in-token") }
    const note = (command: string) => `${brand.binary}: login ${command} acts on the saved sign-in; this process uses the access token handed in through ${ACCESS_TOKEN_FILE_ENV} instead\n`
    const started = await login(["start"], { config: auth.config }, { env })
    expect([started.code, started.err]).toEqual([0, note("start")])
    const finished = await login(["finish"], { config: auth.config }, { env, stdin: await auth.authorize(addressIn(started.out)) })
    expect(finished).toEqual({ code: 0, out: `signed in as ${ACCOUNT.email}\n`, err: note("finish") })
    expect((await loadCredentials(auth.config))?.account).toEqual(ACCOUNT)
    expect(await login(["logout"], { config: auth.config }, { env })).toEqual({ code: 0, out: `signed out: the saved sign-in was removed from ${credentialsPath(auth.config)}\n`, err: note("logout") })
    expect(await loadCredentials(auth.config)).toBeUndefined()
    // Without the variable nothing is added.
    expect((await login(["logout"], { config: auth.config })).err).toBe("")
  })
})
