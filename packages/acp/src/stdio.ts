/**
 * The `acp` subcommand: an ACP agent on stdin and stdout.
 *
 * stdout carries protocol messages and nothing else. Every log line goes to
 * stderr, and `console.log` and its relatives are pointed at stderr too, so a
 * stray print anywhere in the process cannot corrupt the stream.
 *
 * The process ends when the client closes stdin, when stdout goes away, or on
 * SIGTERM, SIGINT or SIGHUP. Each way out is the same graceful shutdown: every
 * session is stopped as a `shutdown` (it resumes later) and let go of, every
 * tool process is stopped, waiting at most
 * `SHUTDOWN_TIMEOUT_MS`. Should the process die anyway, the shell tool's guard
 * still kills the commands' process groups.
 */
import { ndJsonStream } from "@agentclientprotocol/sdk"
import { brand, createHarness } from "@windlass/core"
import { LOG_LEVEL_ENV, createLogger, describeError, levelFromEnv } from "./log.ts"
import { SCRIPT_ENV, scriptedProvider } from "./scripted.ts"
import { serve } from "./server.ts"

/** Longer than the shell tool's grace between SIGTERM and SIGKILL, so a stopped command can wind down. */
export const SHUTDOWN_TIMEOUT_MS = 5000

/**
 * Wake-ups fire in this process: it is the long-lived one. It serves an
 * editor, the terminal interface or an interactive command line for as long
 * as they run, so a wake-up that comes due meanwhile (of any session of the
 * data directory) is delivered here, its session opened for it and let go of
 * again. Several servers may run at once: each firing is delivered by
 * exactly one of them (the wake store's leases), and the webhook listener's
 * port belongs to whichever bound it first (the others record nothing and
 * are not disturbed).
 *
 * A client that starts the server for one prompt and ends it right after
 * sets this variable to `off`: the server it starts would otherwise begin
 * other sessions' wake-up turns and cut them short when it exits (they
 * resume when their session is next opened). The tools work either way: a
 * wake-up created there fires in the next server that runs.
 */
export const WAKE_ENV = `${brand.envPrefix}WAKE`

/** Whether this server fires wake-ups, going by `WAKE_ENV`: yes unless it says `off`, `0`, `false` or `no`. */
export function firesWakeUps(env: Record<string, string | undefined>): boolean {
  return !["off", "0", "false", "no"].includes((env[WAKE_ENV] ?? "").trim().toLowerCase())
}

export interface StdioOptions {
  readonly env: Record<string, string | undefined>
  readonly version?: string
}

export async function serveStdio(options: StdioOptions): Promise<number> {
  const write = (line: string) => void process.stderr.write(line)
  const toStderr = (...args: unknown[]) => write(`${args.map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg))).join(" ")}\n`)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  console.warn = toStderr
  const log = createLogger({ level: levelFromEnv(options.env[LOG_LEVEL_ENV]), write })

  const scriptPath = options.env[SCRIPT_ENV]
  const provider = scriptPath === undefined || scriptPath === "" ? undefined : await scriptedProvider(scriptPath)
  if (provider !== undefined) log.info(`using the scripted model in ${scriptPath} (${SCRIPT_ENV}); no real model is called`)
  // The same harness the command line builds: one data directory, a store per session, the saved sign-in. Its lines
  // (the engine's diagnostics, notices about the data directory) are what the command line prints as warnings too.
  const fires = firesWakeUps(options.env)
  const harness = createHarness({ log: (line) => log.warn(line), ...(provider === undefined ? {} : { provider }), ...(fires ? { engine: { wake: { run: true } } } : {}) })
  // The scheduler and the webhook listener start with the engine, not with the first session: a wake-up that is
  // due is delivered although the client has opened nothing yet.
  if (fires) void harness.engine.wake()

  let outputClosed = false
  const output = new WritableStream<Uint8Array>({
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (outputClosed) return reject(new Error("stdout is closed"))
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()))
      }),
  })
  const served = serve(harness, ndJsonStream(output, Bun.stdin.stream()), { log, ...(options.version === undefined ? {} : { version: options.version }) })

  let stopping: Promise<void> | null = null
  const shutdown = (why: string): Promise<void> => {
    stopping ??= (async () => {
      log.info(`shutting down (${why})`)
      served.connection.close()
      const finished = await within(
        SHUTDOWN_TIMEOUT_MS,
        served.done.then(() => harness.close()),
      )
      if (!finished) log.warn(`the shutdown took longer than ${SHUTDOWN_TIMEOUT_MS} ms; exiting anyway`)
    })().catch((error: unknown) => log.error(`the shutdown failed: ${describeError(error)}`))
    return stopping
  }

  process.stdout.on("error", () => {
    outputClosed = true
    void shutdown("stdout closed")
  })
  process.stderr.on("error", () => {})
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const
  const handlers = signals.map((signal) => {
    const handler = () => void shutdown(signal)
    process.on(signal, handler)
    return () => void process.off(signal, handler)
  })

  log.info(`${brand.name} ACP agent ready on stdio (pid ${process.pid})`)
  await served.connection.closed.catch(() => {})
  await shutdown("the client closed the connection")
  for (const off of handlers) off()
  return 0
}

async function within(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), ms)
  })
  const finished = await Promise.race([work.then(() => true as const), timeout])
  clearTimeout(timer)
  return finished
}
