/**
 * `windlass login`: the ChatGPT sign-in, inside the program. The flow itself is
 * `@windlass/core/auth/chatgpt`, used as it is; this file is the part a
 * person sees.
 *
 * - `login` / `login start`: saves a pending sign-in and prints its address.
 *   Where a browser can be opened (a desktop session, not over SSH) it is
 *   opened, and the browser's return to `127.0.0.1` is caught on the loopback
 *   port. With a terminal on stdin the address the browser ended on can also
 *   be pasted instead (the usual way on a remote machine, where that page
 *   fails to load): it is read with echo off, never from the command line,
 *   where it would land in the shell's history. Whichever comes first wins.
 *   Without a terminal and without a browser it prints the address and says to
 *   run `login finish`.
 * - `login finish`: finishes the pending sign-in from the pasted address
 *   (echo off at a terminal, otherwise one line of stdin).
 * - `login status`: who is signed in, the scopes, and when the access token
 *   is due for its refresh. Never a token.
 * - `login token`: prints a usable access token of the saved sign-in,
 *   refreshed first when it is due, and nothing else on standard output
 *   (`--json`: with its expiry). The one place a token is printed on
 *   purpose: it is for another process of this program, which cannot share
 *   this data directory, to run on this sign-in (`ACCESS_TOKEN_FILE_ENV`).
 * - `login logout`: forgets the saved sign-in on this machine.
 *
 * A process whose access token is handed in (`ACCESS_TOKEN_FILE_ENV` is set)
 * does not use the saved sign-in: `status` describes the file instead,
 * `token` refuses (it holds nothing to hand on), and the others act on the
 * saved sign-in and say so.
 *
 * Exit codes: 0 done, 1 failed (or `status`: signed out; `token`: nothing to
 * hand on), 2 usage, 130 the paste was abandoned with Ctrl-C.
 */
import { brand } from "@windlass/core"
import {
  ACCESS_TOKEN_FILE_ENV,
  type AuthConfig,
  AuthError,
  CHATGPT_AUTH,
  type Credentials,
  LOGIN_PORT,
  type PendingLogin,
  beginLogin,
  credentialsPath,
  finishLogin,
  forgetCredentials,
  handedInTokenFile,
  loadCredentials,
  loadPending,
  readHandedIn,
  savedAccessToken,
} from "@windlass/core/auth/chatgpt"

/** What `runLogin` needs of the process. The CLI's `Io` is one. */
export interface LoginIo {
  readonly env: Record<string, string | undefined>
  readonly stdout: { write(text: string): void }
  readonly stderr: { write(text: string): void }
  readonly stdin: {
    readonly isTTY: boolean
    readAll(): Promise<string>
    listen?(onData: (data: string) => void): () => void
  }
}

/** What a test replaces: the authorization server and data directory, the browser, the port. */
export interface LoginDeps {
  readonly config?: AuthConfig
  /** Opens `url` in a browser; `false` when it could not. Defaults to the platform's opener, when the session looks like it has a display. */
  readonly openBrowser?: ((url: string) => Promise<boolean>) | null
  /** The loopback port the browser comes back to; `0` picks a free one (tests). */
  readonly port?: number
  /** The current time, for `status`. */
  readonly now?: () => number
}

const USAGE = `usage: ${brand.binary} login [start [--no-browser] | finish | status | logout]\n       ${brand.binary} login token [--json]`

/** `login --help`: each form with what it does. */
export const LOGIN_HELP = (() => {
  const forms: [string, string[]][] = [
    [`${brand.binary} login [start]`, ["sign in with ChatGPT: opens a browser when", "there is one, otherwise prints the address", "and asks for the page you ended on (pasted,", "not shown)"]],
    [`  --no-browser`, ["print the address, open no browser"]],
    [`${brand.binary} login finish`, ["finish a sign-in started elsewhere from the", "pasted address"]],
    [`${brand.binary} login status`, ["who is signed in and until when (never the", "tokens); exit code 1 when nobody is"]],
    [`${brand.binary} login token`, ["print an access token of the saved sign-in,", "refreshed when it is due, for another", `${brand.name} that cannot share this data`, "directory: it reads the token from the file", `${ACCESS_TOKEN_FILE_ENV} names. The`, "output is a secret; exit code 1 when there", "is no sign-in to hand on"]],
    [`  --json`, ["with its expiry, on one line:", '{"accessToken":"...","expiresAt":<ms>}']],
    [`${brand.binary} login logout`, ["forget the saved sign-in on this machine"]],
  ]
  const width = Math.max(...forms.map(([form]) => form.length)) + 3
  const rows = forms.flatMap(([form, [first = "", ...rest]]) => [`  ${form.padEnd(width)}${first}`, ...rest.map((line) => `  ${" ".repeat(width)}${line}`)])
  return `${USAGE}\n\n${rows.join("\n")}\n`
})()

export async function runLogin(argv: readonly string[], io: LoginIo, deps: LoginDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout.write(LOGIN_HELP)
    return 0
  }
  const config = deps.config ?? CHATGPT_AUTH
  const [command = "start", ...rest] = argv
  const flags = new Set(rest)
  const known = command === "start" ? ["--no-browser"] : command === "token" ? ["--json"] : []
  const unknown = rest.find((arg) => !known.includes(arg))
  if (unknown !== undefined) return usage(io, unknown.startsWith("-") ? `unknown option ${unknown}` : `login ${command} takes no arguments (the address is pasted when asked, never given on the command line)`)
  // The file this process's access token is handed in through, when it is: it then does not run on the saved sign-in.
  const handedIn = handedInTokenFile(io.env)
  const savedOnly = () => {
    if (handedIn !== null) io.stderr.write(`${brand.binary}: login ${command} acts on the saved sign-in; this process uses the access token handed in through ${ACCESS_TOKEN_FILE_ENV} instead\n`)
  }
  try {
    switch (command) {
      case "start":
        savedOnly()
        return await start(io, config, deps, flags.has("--no-browser"))
      case "finish":
        savedOnly()
        return await finish(io, config)
      case "status":
        return handedIn === null ? await status(io, config, deps.now ?? Date.now) : await handedInStatus(io, handedIn, deps.now ?? Date.now)
      case "token":
        return await token(io, config, handedIn !== null, flags.has("--json"))
      case "logout": {
        savedOnly()
        const had = await forgetCredentials(config)
        io.stdout.write(had ? `signed out: the saved sign-in was removed from ${credentialsPath(config)}\n` : "not signed in; nothing to remove\n")
        return 0
      }
      default:
        return usage(io, `unknown login command "${command}"`)
    }
  } catch (error) {
    if (!(error instanceof AuthError)) throw error
    io.stderr.write(`${brand.binary}: sign-in failed: ${error.message} (${error.code})\n`)
    return 1
  }
}

async function start(io: LoginIo, config: AuthConfig, deps: LoginDeps, noBrowser: boolean): Promise<number> {
  const opener = noBrowser ? null : deps.openBrowser === undefined ? platformOpener(io.env) : deps.openBrowser
  // Listen first, so a free port can be put in the address (tests); the real flow uses its fixed port.
  const listener = listen(deps.port ?? LOGIN_PORT, config)
  const port = listener.port ?? deps.port ?? LOGIN_PORT
  const { url, pending } = await beginLogin({ port, config })
  listener.arm(pending)
  const paste = io.stdin.isTTY && io.stdin.listen !== undefined
  const opened = opener === null ? false : await opener(url).catch(() => false)
  io.stdout.write(`Sign in with your ChatGPT account${opened ? " in the browser that just opened. If it did not open," : "."} Open this address in a browser:\n\n  ${url}\n\n`)
  if (listener.port === null) io.stdout.write(`(port ${port} on 127.0.0.1 is in use, so the browser's return cannot be caught here; paste the address instead)\n`)
  if (!paste) {
    if (!opened || listener.port === null) {
      listener.stop()
      io.stdout.write(`When the browser ends on a page at 127.0.0.1 (it may fail to load; that is expected), copy that page's full address and run \`${brand.binary} login finish\` to paste it.\n`)
      return 0
    }
    io.stdout.write("Waiting for the browser…\n")
    return signedIn(io, await listener.done)
  }
  io.stdout.write(
    `The browser ends on a page at 127.0.0.1. ${opened && listener.port !== null ? "If this machine is the one with the browser, that is all. Otherwise that" : "That"} page may fail to load; copy its full address from the address bar and paste it here.\n`,
  )
  const pasted = readSecret(io, "Address (not shown as you paste): ")
  const winner = await Promise.race([listener.done.then((credentials) => ({ kind: "browser" as const, credentials })), pasted.promise.then((text) => ({ kind: "pasted" as const, text }))])
  if (winner.kind === "browser") {
    pasted.cancel()
    io.stdout.write("\n")
    return signedIn(io, winner.credentials)
  }
  listener.stop()
  if (winner.text === null) {
    io.stderr.write(`${brand.binary}: sign-in abandoned; run \`${brand.binary} login finish\` to paste the address later\n`)
    return 130
  }
  return signedIn(io, await finishLogin(winner.text, pending, config))
}

async function finish(io: LoginIo, config: AuthConfig): Promise<number> {
  const pending = await loadPending(config)
  if (pending === undefined) throw new AuthError("no_pending_login", `No sign-in is in progress. Run \`${brand.binary} login\` first.`)
  const text = io.stdin.isTTY && io.stdin.listen !== undefined ? await readSecret(io, "Address the browser ended on (not shown as you paste): ").promise : firstLine(await io.stdin.readAll())
  if (text === null) {
    io.stderr.write(`${brand.binary}: nothing was pasted; the sign-in is still pending\n`)
    return 130
  }
  if (text.trim() === "") return usage(io, "the pasted address is empty")
  return signedIn(io, await finishLogin(text, pending, config))
}

async function status(io: LoginIo, config: AuthConfig, now: () => number): Promise<number> {
  const credentials = await loadCredentials(config)
  if (credentials === undefined) {
    const pending = await loadPending(config)
    io.stdout.write(`not signed in${pending === undefined ? "" : ` (a sign-in started ${minutesAgo(pending.createdAt, now())} is waiting for \`${brand.binary} login finish\`)`}; run \`${brand.binary} login\`\n`)
    return 1
  }
  const minutes = Math.round((credentials.expiresAt - now()) / 60000)
  const lines = [
    `signed in as ${credentials.account.email ?? credentials.account.sub}`,
    `plan usage: ${credentials.scopes.includes("chatgpt.tokens.use.direct") ? "granted" : "not granted"}`,
    `access token: ${minutes > 0 ? `valid for ${minutes} more minutes` : `expired ${-minutes} minutes ago`}; it is refreshed when it is due`,
    `saved in ${credentialsPath(config)}`,
  ]
  io.stdout.write(`${lines.join("\n")}\n`)
  return 0
}

/** `status` of a process whose access token is handed in: the file, its expiry when it states one, and whether it can be used. Never the token. */
async function handedInStatus(io: LoginIo, file: string, now: () => number): Promise<number> {
  const handed = await readHandedIn(file, now())
  const minutes = handed.expiresAt === null ? null : Math.round((handed.expiresAt - now()) / 60000)
  const lines = [
    handed.usable
      ? `signed in with the access token handed in through ${ACCESS_TOKEN_FILE_ENV} (the saved sign-in is not used)`
      : `not signed in: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} cannot be used (the saved sign-in is not used)`,
    `access token file: ${file}`,
    ...(minutes !== null ? [`access token: ${handed.usable ? `valid for ${minutes} more minutes` : `expired ${-minutes} minutes ago`}; whoever handed it in replaces the file`] : handed.usable ? ["access token: the file states no expiry"] : []),
    ...(handed.usable ? [] : [`${handed.message} (${handed.code})`]),
  ]
  io.stdout.write(`${lines.join("\n")}\n`)
  return handed.usable ? 0 : 1
}

/**
 * Prints a usable access token of the saved sign-in (refreshed first when it is due, under the refresh lock, as a
 * model call would) and nothing else on standard output. A process that runs on a handed-in token holds no sign-in.
 */
async function token(io: LoginIo, config: AuthConfig, handedIn: boolean, json: boolean): Promise<number> {
  if (handedIn) {
    io.stderr.write(`${brand.binary}: no token to hand on: this process uses the access token handed in through ${ACCESS_TOKEN_FILE_ENV} and holds no sign-in; run \`${brand.binary} login token\` where the sign-in is saved\n`)
    return 1
  }
  const saved = await savedAccessToken(config).catch((error: unknown) => {
    if (error instanceof AuthError && error.code === "signed_out") return null
    throw error
  })
  if (saved === null) {
    io.stderr.write(`${brand.binary}: not signed in, so there is no token to hand on; run \`${brand.binary} login\`\n`)
    return 1
  }
  io.stdout.write(`${json ? JSON.stringify({ accessToken: saved.accessToken, expiresAt: saved.expiresAt }) : saved.accessToken}\n`)
  return 0
}

function signedIn(io: LoginIo, credentials: Credentials): number {
  io.stdout.write(`signed in as ${credentials.account.email ?? credentials.account.sub}\n`)
  return 0
}

/**
 * The loopback listener for the browser's return. `port` is `null` when it
 * could not be bound. `done` settles once a callback for the armed sign-in
 * arrived and was finished (or failed); it never settles otherwise.
 */
function listen(port: number, config: AuthConfig) {
  let pending: PendingLogin | null = null
  let settle: { resolve: (credentials: Credentials) => void; reject: (error: unknown) => void } | null = null
  const done = new Promise<Credentials>((resolve, reject) => {
    settle = { resolve, reject }
  })
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname !== "/auth/callback" || pending === null) return new Response("Not found", { status: 404 })
        try {
          const credentials = await finishLogin(request.url, pending, config)
          settle?.resolve(credentials)
          return new Response(`Signed in to ${brand.name}. You can close this window.`)
        } catch (error) {
          settle?.reject(error)
          return new Response("Sign-in failed. The terminal says why.", { status: 400 })
        } finally {
          setTimeout(() => server?.stop(true), 100)
        }
      },
    })
  } catch {
    server = null
  }
  return {
    port: server?.port ?? null,
    arm: (login: PendingLogin) => {
      pending = login
    },
    done,
    stop: () => server?.stop(true),
  }
}

/**
 * Reads one line at the terminal with echo off. `promise` is the line, or
 * `null` after Ctrl-C or Ctrl-D on an empty line; `cancel` lets go of the
 * terminal without an answer.
 */
function readSecret(io: LoginIo, prompt: string): { promise: Promise<string | null>; cancel: () => void } {
  io.stdout.write(prompt)
  let text = ""
  let stop: (() => void) | null = null
  let finish: (value: string | null) => void = () => {}
  const promise = new Promise<string | null>((resolve) => {
    finish = (value) => {
      stop?.()
      stop = null
      io.stdout.write("\n")
      resolve(value)
    }
  })
  stop = io.stdin.listen!((data) => {
    // A bracketed paste arrives wrapped in markers; they are not part of the address.
    for (const char of data.replace(/\x1b\[20[01]~/g, "")) {
      if (char === "\r" || char === "\n") return finish(text)
      if (char === "\x03") return finish(null)
      if (char === "\x04") return finish(text === "" ? null : text)
      if (char === "\x7f" || char === "\b") text = text.slice(0, -1)
      else if (char >= " ") text += char
    }
  })
  return {
    promise,
    cancel: () => {
      stop?.()
      stop = null
    },
  }
}

/** Opens a URL with the platform's opener, when this looks like a session with a display (not SSH). */
function platformOpener(env: Record<string, string | undefined>): ((url: string) => Promise<boolean>) | null {
  if (env.SSH_CONNECTION !== undefined || env.SSH_TTY !== undefined) return null
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY) ? "xdg-open" : null
  if (command === null || Bun.which(command) === null) return null
  return async (url) => {
    const child = Bun.spawn([command, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    return (await child.exited) === 0
  }
}

function firstLine(text: string): string | null {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== "")
  return line === undefined ? null : line.trim()
}

function minutesAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000))
  return minutes === 0 ? "just now" : `${minutes} minutes ago`
}

function usage(io: LoginIo, message: string): number {
  io.stderr.write(`${brand.binary}: ${message}\n${USAGE}\n`)
  return 2
}
