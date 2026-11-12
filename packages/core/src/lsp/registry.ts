/**
 * The configured language servers of one working directory, and the call the
 * engine makes after a file tool wrote a file.
 *
 * - One server process per (server, workspace root). The root is the nearest
 *   directory above the file, inside the working directory, that holds one of
 *   the server's `rootMarkers`; without one, the working directory. A file
 *   outside the working directory gets no diagnostics and starts nothing.
 * - Started lazily, in the background, the first time a file it serves is
 *   observed or diagnosed; never awaited past the caller's bound. A server the
 *   project's file names and the user has not approved is never started.
 * - A server that crashes or fails to start is not restarted in a loop: it is
 *   started again at the next use after a backoff (1 s, doubling, at most
 *   5 min; the count resets once it has run for 30 s).
 * - `diagnose` returns within `waitMs` (plus scheduling), whatever the servers
 *   do: no answer in time, a crash, a server still starting all return no
 *   note, and say why to the user once per server and reason (`onNotice`).
 * - `stop()` shuts every server down (`shutdown`, `exit`, then the process
 *   group); a guard process kills the group if the harness dies first.
 */
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { serverEnvironment } from "../mcp/config.ts"
import { type LspSession, type OpenDocument, startSession } from "./client.ts"
import { type LspPlan, type LspServerPlan, type LspServerQuestion, lspApprovalKey, lspServerQuestion } from "./config.ts"
import { type Comparison, type DiagnosticSet, type Severity, compareDiagnostics } from "./diagnostics.ts"
import { renderNote } from "./note.ts"
import { type Connection, LspError, openConnection } from "./transport.ts"

export interface LspRegistryOptions {
  readonly plan: LspPlan
  /** The session's working directory: roots are found inside it and paths in the note are relative to it. */
  readonly cwd: string
  /** Where `${NAME}` in `env` and the base variables come from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** How long to keep listening after the first fresh publication, for a second one (within the bound). Default 100 ms. */
  readonly settleMs?: number
  /** Shutdown answer wait, then stdin close, then SIGTERM, each this long. Default 1000 ms. */
  readonly graceMs?: number
  readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number; readonly stableMs?: number }
  /** Open documents per server before the least recently used is closed. Default 200. */
  readonly maxOpenDocuments?: number
  /** Told why diagnostics were not added, once per server and reason. For the user, never the model. */
  readonly onNotice?: (notice: LspNotice) => void
}

export type NoticeKind = "not_approved" | "start_failed" | "starting" | "timeout" | "crashed" | "no_server"

export interface LspNotice {
  readonly server: string | null
  readonly kind: NoticeKind
  readonly message: string
}

export interface DiagnoseRequest {
  /** Absolute, or relative to `cwd`. */
  readonly path: string
  /** The file's text before the edit, or `null` when the edit created it. */
  readonly before: string | null
  /** The file's text as the tool left it. */
  readonly after: string
  readonly signal?: AbortSignal
}

export type ServerOutcome =
  /** Compared: `comparison.added` may be empty (nothing worse). */
  | "compared"
  /** The edit left the text as it was. */
  | "unchanged"
  /** No fresh diagnostics within the bound (server starting, slow, or a later edit of the same file came first). */
  | "timeout"
  /** The server is not running: it failed to start or crashed, and waits for its backoff. */
  | "not_running"
  /** It stopped while the call waited. */
  | "crashed"
  /** A project's server the user has not approved. Not started. */
  | "not_approved"
  | "interrupted"

export interface ServerReport {
  readonly server: string
  readonly root: string | null
  readonly outcome: ServerOutcome
  readonly comparison: Comparison | null
  /** Why there is no comparison, for the user. */
  readonly detail: string | null
}

export interface DiagnoseResult {
  /** The text to add after the tool's output, or `null`. Frozen once added. */
  readonly note: string | null
  /** One per server that serves the file. Empty when none does (`skipped` says why). */
  readonly servers: readonly ServerReport[]
  readonly skipped: "off" | "outside_workspace" | "no_server" | "too_large" | null
  /** Diagnostics shown in the note and new ones left out of it. */
  readonly listed: number
  readonly omitted: number
  readonly waitedMs: number
}

export type ServerState = "idle" | "starting" | "ready" | "retrying" | "stopped"

export interface LspServerStatus {
  readonly server: string
  readonly root: string
  readonly state: ServerState
  readonly pid: number | null
  readonly error: string | null
  readonly restarts: number
  readonly openDocuments: number
}

export interface LspRegistry {
  /**
   * The agent read (or otherwise saw) a file: start its servers if needed and
   * open the document with this text, so the edit that follows has the
   * diagnostics from before it. Never waits.
   */
  observe(path: string, text: string): void
  /** What the edit made worse, within the bound. Never throws. */
  diagnose(request: DiagnoseRequest): Promise<DiagnoseResult>
  status(): LspServerStatus[]
  /** The project's servers that wait for the user's approval. */
  awaitingApproval(): LspServerQuestion[]
  /** The user approved a project's server (by `lspApprovalKey`): it may start from the next use. Unknown keys are ignored. */
  approve(key: string): void
  stop(): Promise<void>
}

interface Managed {
  readonly key: string
  readonly plan: LspServerPlan
  readonly root: string
  state: ServerState
  session: LspSession | null
  connection: Connection | null
  starting: Promise<LspSession | null> | null
  failures: number
  restarts: number
  retryAt: number
  readyAt: number
  error: string | null
  /** Open documents, least recently used first. */
  readonly used: Map<string, OpenDocument>
}

const TIMEOUT = Symbol("timeout")
const ABORTED = Symbol("aborted")

export function createLspRegistry(options: LspRegistryOptions): LspRegistry {
  const config = options.plan.config
  const cwd = resolve(options.cwd)
  const env = options.env ?? process.env
  const settleMs = options.settleMs ?? 100
  const graceMs = options.graceMs ?? 1000
  const initialMs = options.backoff?.initialMs ?? 1000
  const maxMs = options.backoff?.maxMs ?? 5 * 60_000
  const stableMs = options.backoff?.stableMs ?? 30_000
  const maxOpen = options.maxOpenDocuments ?? 200
  const severities = new Set<Severity>(config.warnings ? [1, 2] : [1])
  const approvedKeys = new Set<string>()
  const isApproved = (plan: LspServerPlan) => plan.approved || approvedKeys.has(lspApprovalKey(plan))
  const servers = options.plan.servers.filter((plan) => plan.config.enabled)
  const globs = new Map(servers.map((plan) => [plan.config.name, plan.config.languages.map((language) => ({ languageId: language.languageId, globs: language.patterns.map((pattern) => new Bun.Glob(pattern)) }))]))
  const managed = new Map<string, Managed>()
  const noticed = new Set<string>()
  let stopped = false

  const notice = (server: string | null, kind: NoticeKind, key: string, message: string) => {
    if (noticed.has(key)) return
    noticed.add(key)
    try {
      options.onNotice?.({ server, kind, message })
    } catch {
      // A listener's failure is not the registry's.
    }
  }

  /** The file relative to the working directory with `/`, or `null` outside it. */
  const relativeTo = (path: string): { absolute: string; relative: string } | null => {
    const absolute = resolve(cwd, path)
    const rel = relative(cwd, absolute)
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
    return { absolute, relative: sep === "/" ? rel : rel.split(sep).join("/") }
  }

  const serving = (rel: string) =>
    servers.flatMap((plan) => {
      const language = globs.get(plan.config.name)!.find((entry) => entry.globs.some((glob) => glob.match(rel)))
      return language === undefined ? [] : [{ plan, languageId: language.languageId }]
    })

  const rootOf = (plan: LspServerPlan, absolute: string): string => {
    if (plan.config.rootMarkers.length === 0) return cwd
    for (let dir = dirname(absolute); ; dir = dirname(dir)) {
      if (plan.config.rootMarkers.some((marker) => existsSync(join(dir, marker)))) return dir
      if (dir === cwd || dirname(dir) === dir) return cwd
    }
  }

  const managedFor = (plan: LspServerPlan, root: string): Managed => {
    const key = `${plan.config.name}\u0000${root}`
    let entry = managed.get(key)
    if (entry === undefined) {
      entry = { key, plan, root, state: "idle", session: null, connection: null, starting: null, failures: 0, restarts: 0, retryAt: 0, readyAt: 0, error: null, used: new Map() }
      managed.set(key, entry)
    }
    return entry
  }

  const fail = (m: Managed, reason: string, kind: "start_failed" | "crashed") => {
    m.session = null
    m.connection = null
    m.starting = null
    m.used.clear()
    if (stopped) {
      m.state = "stopped"
      return
    }
    if (kind === "crashed" && m.readyAt > 0 && performance.now() - m.readyAt >= stableMs) m.failures = 0
    m.failures += 1
    const delay = Math.min(maxMs, initialMs * 2 ** (m.failures - 1))
    m.state = "retrying"
    m.retryAt = performance.now() + delay
    m.error = reason
    const name = m.plan.config.name
    notice(
      name,
      kind,
      `${name}:${kind}`,
      kind === "crashed"
        ? `The language server "${name}" stopped (${reason}). Edits get no diagnostics until it is started again, at the next edit after ${Math.round(delay / 1000)} s.`
        : `The language server "${name}" could not be started: ${reason}. Edits get no diagnostics from it; it is tried again at the next edit after ${Math.round(delay / 1000)} s.`,
    )
  }

  /** The running session, the start in progress, or `null` when it waits for its backoff. Starts it if it may. */
  const ensure = (m: Managed): Promise<LspSession | null> | LspSession | null => {
    if (stopped) return null
    if (m.state === "ready") return m.session
    if (m.state === "starting") return m.starting
    if (m.state === "retrying" && performance.now() < m.retryAt) return null
    if (m.state === "retrying") m.restarts += 1
    m.state = "starting"
    m.starting = start(m)
    return m.starting
  }

  const start = async (m: Managed): Promise<LspSession | null> => {
    const server = m.plan.config
    const environment = serverEnvironment(server.env, env)
    if (!environment.ok) {
      fail(m, `the environment variable ${environment.missing} named in its env is not set`, "start_failed")
      return null
    }
    let connection: Connection
    try {
      connection = openConnection({ command: server.command, args: server.args, cwd: m.root, env: environment.env, graceMs })
    } catch (error) {
      fail(m, error instanceof Error ? error.message : String(error), "start_failed")
      return null
    }
    m.connection = connection
    try {
      const session = await startSession(connection, {
        rootPath: m.root,
        initializationOptions: server.initializationOptions,
        settings: server.settings,
        timeoutMs: server.startupTimeoutSeconds * 1000,
      })
      if (stopped) {
        await session.shutdown(graceMs)
        return null
      }
      m.session = session
      m.state = "ready"
      m.readyAt = performance.now()
      m.error = null
      m.starting = null
      void connection.closed.then((reason) => {
        if (m.session === session) fail(m, withStderr(reason, connection), "crashed")
      })
      return session
    } catch (error) {
      const reason = error instanceof LspError && error.kind === "timeout" ? `it did not answer initialize within ${server.startupTimeoutSeconds} s` : error instanceof Error ? error.message : String(error)
      await connection.close()
      fail(m, withStderr(reason, connection), "start_failed")
      return null
    }
  }

  const touch = (m: Managed, document: OpenDocument) => {
    m.used.delete(document.uri)
    m.used.set(document.uri, document)
    while (m.used.size > maxOpen && m.session !== null) {
      const oldest = m.used.values().next().value!
      m.used.delete(oldest.uri)
      m.session.close(oldest)
    }
  }

  const sync = (m: Managed, session: LspSession, absolute: string, languageId: string, text: string): OpenDocument => {
    const existing = session.document(pathToFileURL(absolute).href)
    const document = existing ?? session.open(absolute, languageId, text)
    if (existing !== undefined && existing.text !== text) session.change(existing, text)
    touch(m, document)
    return document
  }

  const diagnoseOne = async (
    plan: LspServerPlan,
    languageId: string,
    absolute: string,
    request: DiagnoseRequest,
    deadline: number,
  ): Promise<ServerReport> => {
    const name = plan.config.name
    if (!isApproved(plan)) {
      notice(name, "not_approved", `${name}:not_approved`, `The language server "${name}" from this project's configuration is not started: it waits for your approval.`)
      return { server: name, root: null, outcome: "not_approved", comparison: null, detail: "waits for the user's approval" }
    }
    const m = managedFor(plan, rootOf(plan, absolute))
    const report = (outcome: ServerOutcome, detail: string | null, comparison: Comparison | null = null): ServerReport => ({ server: name, root: m.root, outcome, comparison, detail })
    const started = await within(ensure(m), deadline, request.signal)
    if (started === ABORTED) return report("interrupted", null)
    if (started === TIMEOUT) {
      notice(name, "starting", `${name}:starting`, `The language server "${name}" was still starting when an edit needed its diagnostics; the edit got none. Later edits get them once it is ready.`)
      return report("timeout", "the server was still starting")
    }
    if (started === null) return report("not_running", m.error)
    const session = started
    const empty: DiagnosticSet = { diagnostics: [], total: 0, invalid: 0 }
    const uri = pathToFileURL(absolute).href
    if (request.before === request.after) {
      sync(m, session, absolute, languageId, request.after)
      return report("unchanged", null)
    }
    let beforeText: string
    let baseline: DiagnosticSet | null
    if (request.before === null) {
      // A new file: everything in it is this edit's.
      beforeText = ""
      baseline = empty
    } else {
      beforeText = request.before
      const document = sync(m, session, absolute, languageId, request.before)
      baseline = await within(session.diagnostics(document, deadline, settleMs, request.signal), deadline, request.signal).then((value) => (typeof value === "symbol" ? null : value))
    }
    if (request.signal?.aborted) {
      sync(m, session, absolute, languageId, request.after)
      return report("interrupted", null)
    }
    const document = sync(m, session, absolute, languageId, request.after)
    session.save(document)
    if (baseline === null) return timedOut(m, "no diagnostics for the file as it was before the edit")
    const after = await within(session.diagnostics(document, deadline, settleMs, request.signal), deadline, request.signal)
    if (after === ABORTED || request.signal?.aborted) return report("interrupted", null)
    if (session.connection.isClosed()) return report("crashed", m.error ?? "the server stopped while the edit waited for its diagnostics")
    if (after === TIMEOUT || after === null) return timedOut(m, document.version === session.document(uri)?.version ? "no diagnostics for the edited file in time" : "a later edit of the file came first")
    return report("compared", null, compareDiagnostics({ text: beforeText, diagnostics: baseline.diagnostics }, { text: request.after, diagnostics: after.diagnostics }, severities))
  }

  const timedOut = (m: Managed, detail: string): ServerReport => {
    const name = m.plan.config.name
    notice(name, "timeout", `${name}:timeout`, `The language server "${name}" did not give diagnostics within ${config.waitMs} ms of an edit, so the edit got none. This is said once; it may keep happening if the server is slow.`)
    return { server: name, root: m.root, outcome: "timeout", comparison: null, detail }
  }

  return {
    observe(path, text) {
      if (stopped || !config.enabled || config.waitMs === 0) return
      const file = relativeTo(path)
      if (file === null || tooLarge(text)) return
      for (const { plan, languageId } of serving(file.relative)) {
        if (!isApproved(plan)) continue
        const m = managedFor(plan, rootOf(plan, file.absolute))
        const ready = ensure(m)
        void Promise.resolve(ready).then((session) => {
          if (session !== null && !stopped && !session.connection.isClosed()) sync(m, session, file.absolute, languageId, text)
        })
      }
    },

    async diagnose(request) {
      const began = performance.now()
      const done = (fields: Omit<DiagnoseResult, "waitedMs">): DiagnoseResult => ({ ...fields, waitedMs: Math.round(performance.now() - began) })
      const nothing = { note: null, servers: [], listed: 0, omitted: 0 }
      try {
        if (stopped || !config.enabled || config.waitMs === 0) return done({ ...nothing, skipped: "off" })
        const file = relativeTo(request.path)
        if (file === null) return done({ ...nothing, skipped: "outside_workspace" })
        if (tooLarge(request.after) || (request.before !== null && tooLarge(request.before))) return done({ ...nothing, skipped: "too_large" })
        const matches = serving(file.relative)
        if (matches.length === 0) {
          if (servers.length > 0) {
            const extension = file.relative.includes(".") ? file.relative.slice(file.relative.lastIndexOf(".")) : file.relative.split("/").pop()!
            notice(null, "no_server", `no_server:${extension}`, `No configured language server serves ${extension} files, so edits of them get no diagnostics.`)
          }
          return done({ ...nothing, skipped: "no_server" })
        }
        const deadline = began + config.waitMs
        const reports = await Promise.all(matches.map(({ plan, languageId }) => diagnoseOne(plan, languageId, file.absolute, request, deadline)))
        const sections = reports.flatMap((r) => (r.comparison === null ? [] : [{ server: r.server, comparison: r.comparison }]))
        const note = renderNote(file.relative, sections, { maxItems: config.maxDiagnostics })
        return done({ note: note.text, servers: reports, skipped: null, listed: note.listed, omitted: note.omitted })
      } catch {
        // Diagnostics are optional: whatever went wrong, the tool's result goes on without a note.
        return done({ ...nothing, skipped: null })
      }
    },

    status: () =>
      [...managed.values()]
        .map((m) => ({
          server: m.plan.config.name,
          root: m.root,
          state: m.state,
          pid: m.connection?.pid ?? null,
          error: m.error,
          restarts: m.restarts,
          openDocuments: m.session?.openCount() ?? 0,
        }))
        .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : 0)),

    awaitingApproval: () => servers.filter((plan) => !isApproved(plan)).map(lspServerQuestion),

    approve(key) {
      if (servers.some((plan) => lspApprovalKey(plan) === key)) approvedKeys.add(key)
    },

    async stop() {
      stopped = true
      await Promise.all(
        [...managed.values()].map(async (m) => {
          const session = m.session
          const connection = m.connection
          m.session = null
          m.state = "stopped"
          if (session !== null) await session.shutdown(graceMs)
          else if (connection !== null) await connection.close()
          if (m.starting !== null) await m.starting
          m.connection = null
        }),
      )
    },
  }
}

/** Larger files, and files with NUL characters (not text), are not sent to a server. */
export const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024

function tooLarge(text: string): boolean {
  return text.length > MAX_DOCUMENT_CHARS || text.includes("\u0000")
}

/** The value, or `TIMEOUT` at the deadline, or `ABORTED` when the signal fires. Never waits past the deadline. */
async function within<T>(value: Promise<T> | T, deadline: number, signal?: AbortSignal): Promise<T | typeof TIMEOUT | typeof ABORTED> {
  if (!(value instanceof Promise)) return value
  if (signal?.aborted) return ABORTED
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      value,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - performance.now()))
      }),
      new Promise<typeof ABORTED>((resolve) => {
        onAbort = () => resolve(ABORTED)
        signal?.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort)
  }
}

function withStderr(reason: string, connection: Connection): string {
  const tail = connection.stderrTail().trim().split("\n").slice(-3).join(" | ").slice(-300)
  return tail === "" ? reason : `${reason}; it wrote: ${tail}`
}
