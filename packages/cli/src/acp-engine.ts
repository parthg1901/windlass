/**
 * The engine behind the CLI's `Engine` interface, reached through the Agent
 * Client Protocol: the CLI is an ACP client of the harness's own ACP server,
 * the same one editors start. Nothing here touches the engine directly; what
 * the protocol cannot carry, the CLI cannot do.
 *
 * Two transports reach the same server:
 * - `child` (the default): `lh acp` as a child process over stdio. It is the
 *   real thing an editor runs, and a crash of the engine is a crash of that
 *   process, which the CLI survives to report. The child gets its own
 *   process group, so a Ctrl-C at the terminal reaches only the CLI, which
 *   turns it into `session/cancel`; it leaves when its stdin closes, which
 *   also happens when the CLI dies.
 * - `memory`: the server in this process over in-memory streams, for tests
 *   and debugging. Messages are copied as JSON, as the wire would.
 *
 * What the CLI's renderer needs is the harness's own event stream, so the
 * client asks for it at `initialize` (`clientCapabilities._meta[<ns>] =
 * { events: true, updates: false }`): every event arrives as a
 * `<prefix>/event` notification, and no standard `session/update`s are sent.
 * The mapping, call by call:
 *
 * - `open`: `session/new` with the model and effort in `_meta[<ns>]`; for
 *   `--session` and `--continue`, `<prefix>/resolve` names the session, then
 *   `session/resume` opens it (a crashed claim's recovery events arrive as
 *   live events before the answer).
 * - `send`: `<prefix>/steer` or `<prefix>/queue` with `maxSteps`, answered
 *   once the message is admitted. A turn ends for the CLI at its
 *   `execution.*` event, as on the direct path.
 * - `interrupt`: `session/cancel`.
 * - `revert` / `undoRevert`: `<prefix>/revert` / `<prefix>/undo_revert`; with
 *   `handEdits: "ask"` the server asks with `session/request_permission`,
 *   which is answered by the question's `confirm`.
 * - `close`: `session/close` with `_meta[<ns>].shutdown`: running work stops
 *   as a shutdown, and every event of it arrives before the answer. Then the
 *   connection is closed and the child leaves.
 * - `listSessions`: `session/list`; `listModels`: `<prefix>/models`.
 */
import { type ClientConnection, PROTOCOL_VERSION, type RequestPermissionRequest, type RequestPermissionResponse, type Stream, client, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { EXT, META } from "@light-harness/acp/extensions"
import { type HarnessOptions, type MessageId, type RevertPlan, type RevertResult, type SessionId, brand } from "@light-harness/core"
import {
  type Engine,
  type EngineEvent,
  EngineUnavailable,
  type HandEditQuestion,
  type ModelInfo,
  type OpenRequest,
  SIGN_IN_ADVICE,
  type SendOptions,
  type Session,
  type SessionRevertOptions,
  type SessionSummary,
} from "./engine.ts"

export interface AcpEngineOptions {
  /** `child` (the default) or `memory`. */
  readonly transport?: "child" | "memory"
  /** `child`: the command that serves ACP on stdio. Defaults to this Bun running this CLI's `acp` subcommand. */
  readonly command?: readonly string[]
  /** `child`: its environment. Defaults to this process's. */
  readonly env?: Record<string, string | undefined>
  /** `memory`: the harness the in-process server runs on. */
  readonly harness?: HarnessOptions
  /** Where the server's warnings and errors go, as the CLI's own lines (`lh: ...`). Defaults to standard error. */
  readonly stderr?: (text: string) => void
  /** How long the server may take to answer `initialize`. */
  readonly startTimeoutMs?: number
  /** Sent as `clientInfo.version`. */
  readonly version?: string
}

/** How long `lh acp` may take to start and answer `initialize` before the CLI gives up on it. */
export const START_TIMEOUT_MS = 20_000
/** Overrides `START_TIMEOUT_MS`, in milliseconds. */
export const START_TIMEOUT_ENV = `${brand.binary.toUpperCase()}_ENGINE_START_TIMEOUT_MS`

const MAIN = new URL("./main.ts", import.meta.url).pathname
const NS = META.capabilities

export function createAcpEngine(options: AcpEngineOptions = {}): Engine {
  let started: Promise<Link> | null = null
  const link = () => (started ??= Link.start(options))
  // A listing is all the run does: the server is let go of right after it.
  const once = async <T>(work: (connected: Link) => Promise<T>): Promise<T> => {
    const connected = await link()
    try {
      return await work(connected)
    } finally {
      await connected.stop()
    }
  }
  return {
    open: async (request) => (await link()).open(request),
    listSessions: ({ cwd }) => once((connected) => connected.listSessions(cwd)),
    listModels: () => once((connected) => connected.listModels()),
  }
}

/** One way to the server: a stream of messages and how to let go of it. */
interface Transport {
  readonly stream: Stream
  /** Resolves with how the server went, once it has (the child exited). Never rejects. */
  readonly gone: Promise<string>
  /** Closes the server's input and waits for it to finish. */
  stop(): Promise<void>
  /** Stops the server at once (it did not start in time). */
  kill(): void
}

/** The connection to the server, for one CLI run. */
class Link {
  readonly sessions = new Map<string, AcpSession>()
  /** Events for a session whose `session/new` has not been answered yet. */
  private readonly early = new Map<string, EngineEvent[]>()
  private stopping: Promise<void> | null = null
  /** Why the server went away without being asked to, once it has. */
  private lostReason: string | null = null
  readonly connection: ClientConnection

  private constructor(
    private readonly transport: Transport,
    private readonly options: AcpEngineOptions,
  ) {
    this.connection = client({ name: brand.binary })
      .onNotification(EXT.event, parseEventParams, ({ params }) => this.deliver(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.answer(params))
      // Everything else the server says (its own state and turn notifications) the events already tell.
      .onNotification("*", () => {})
      .connect(transport.stream)
    void this.connection.closed
      .catch(() => {})
      .then(() => this.onClosed())
  }

  static async start(options: AcpEngineOptions): Promise<Link> {
    const transport = options.transport === "memory" ? await memoryTransport(options) : childTransport(options)
    const link = new Link(transport, options)
    const timeoutMs = options.startTimeoutMs ?? startTimeout(options.env ?? process.env)
    let timer: ReturnType<typeof setTimeout> | undefined
    const failed = (message: string) => new EngineUnavailable(message)
    try {
      const init = await Promise.race([
        link.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } },
          clientInfo: { name: brand.binary, title: brand.name, version: options.version ?? "0.0.0" },
        }),
        transport.gone.then((how) => {
          throw failed(`the engine process ${how} before it was ready`)
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed(`the engine process did not start within ${Math.round(timeoutMs / 1000)} s; giving up`)), timeoutMs)
        }),
      ])
      const offered = (init.agentCapabilities?._meta?.[NS] as { notifications?: unknown } | undefined)?.notifications
      if (!Array.isArray(offered) || !offered.includes(EXT.event))
        throw failed(`the engine process does not send ${brand.name}'s events (${EXT.event}); it may be another version`)
      return link
    } catch (error) {
      transport.kill()
      await link.stop()
      if (error instanceof EngineUnavailable) throw error
      throw failed(`the engine process did not answer as expected: ${describe(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  get agent() {
    return this.connection.agent
  }

  get gone(): boolean {
    return this.lostReason !== null || this.stopping !== null
  }

  async open(request: OpenRequest): Promise<Session> {
    const meta = { [NS]: { model: request.model, effort: request.effort } }
    const target = request.session
    try {
      if (target.kind === "new") {
        // The events of the new session (`session.created`) arrive before the answer: they wait in `early`.
        const created = await this.agent.request(methods.agent.session.new, { cwd: request.cwd, mcpServers: [], _meta: meta })
        return this.attach(created.sessionId, request)
      }
      const named = await this.agent.request<{ sessionId: string; cwd: string }>(EXT.resolve, {
        cwd: request.cwd,
        ...(target.kind === "resume" ? { session: target.id } : {}),
      })
      // The session is created before the answer, so that the recovery events that come with it have a place to go.
      const session = this.attach(named.sessionId, request)
      try {
        await this.agent.request(methods.agent.session.resume, { sessionId: named.sessionId, cwd: named.cwd, mcpServers: [], _meta: { [NS]: { ...meta[NS], archived: true } } })
      } catch (error) {
        this.sessions.delete(named.sessionId)
        throw error
      }
      return session
    } catch (error) {
      throw this.unavailable(error)
    }
  }

  async listSessions(cwd: string): Promise<SessionSummary[]> {
    const rows: SessionSummary[] = []
    let cursor: string | undefined
    try {
      do {
        const page = await this.agent.request(methods.agent.session.list, { cwd, ...(cursor === undefined ? {} : { cursor }) })
        for (const info of page.sessions) {
          const meta = info._meta?.[NS] as { model?: string } | undefined
          rows.push({ id: info.sessionId as SessionId, title: info.title ?? null, cwd: info.cwd, updatedAt: Date.parse(info.updatedAt ?? ""), model: meta?.model ?? "" })
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
    } catch (error) {
      throw this.unavailable(error)
    }
    return rows
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const listed = await this.agent.request<{ defaultModel: string; models: { id: string; name: string; efforts: string[] }[] }>(EXT.models, {})
      return listed.models.map((model) => ({
        id: model.id,
        description: model.name === model.id ? null : model.name,
        efforts: model.efforts,
        isDefault: model.id === listed.defaultModel,
      }))
    } catch (error) {
      const data = errorData(error)
      if (data?.reason === "auth_required" && typeof data.message === "string") throw new EngineUnavailable(`could not list the models: ${data.message} (${SIGN_IN_ADVICE})`)
      throw this.unavailable(error)
    }
  }

  /** Lets go of the server: its input is closed, and it shuts down what it still runs and exits. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const session of this.sessions.values()) session.end()
      this.connection.close()
      await this.transport.stop()
    })()
    return this.stopping
  }

  /** Why the server went away on its own, for the session `id`, or `null`. */
  lost(id: string): string | null {
    if (this.lostReason === null) return null
    return `the engine process ${this.lostReason} in the middle of the session; its work is recovered when it is opened again (${brand.binary} --session ${id})`
  }

  /** The error the CLI prints for something the server refused, or for the server being gone. */
  unavailable(error: unknown): EngineUnavailable {
    if (error instanceof EngineUnavailable) return error
    if (this.lostReason !== null) return new EngineUnavailable(`the engine process ${this.lostReason}`)
    const data = errorData(error)
    if (data?.reason === "auth_required" && typeof data.message === "string") return new EngineUnavailable(`${data.message} (${SIGN_IN_ADVICE})`)
    if (typeof data?.message === "string") return new EngineUnavailable(data.message)
    return new EngineUnavailable(describe(error))
  }

  private attach(sessionId: string, request: OpenRequest): AcpSession {
    const session = new AcpSession(this, sessionId as SessionId, request.maxSteps)
    this.sessions.set(sessionId, session)
    for (const item of this.early.get(sessionId) ?? []) session.push(item)
    this.early.delete(sessionId)
    return session
  }

  private deliver(params: { sessionId: string; event: EngineEvent; replay?: boolean }): void {
    // A replay is history the CLI does not show; it never asks for one.
    if (params.replay === true) return
    const session = this.sessions.get(params.sessionId)
    if (session !== undefined) return session.push(params.event)
    const waiting = this.early.get(params.sessionId) ?? []
    waiting.push(params.event)
    this.early.set(params.sessionId, waiting)
  }

  private async answer(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const session = this.sessions.get(params.sessionId)
    const meta = params._meta?.[NS] as { plan?: RevertPlan } | undefined
    const answer = session === undefined || meta?.plan === undefined ? null : await session.ask(meta.plan)
    return { outcome: answer === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: answer } }
  }

  private async onClosed(): Promise<void> {
    if (this.stopping !== null) return
    this.lostReason = await this.transport.gone
    for (const session of this.sessions.values()) session.end()
  }
}

class AcpSession implements Session {
  private readonly queue = new EventQueue<EngineEvent>()
  private question: HandEditQuestion | null = null
  private closing: Promise<void> | null = null

  constructor(
    private readonly link: Link,
    readonly id: SessionId,
    private readonly maxSteps: number | null,
  ) {}

  get events(): AsyncIterable<EngineEvent> {
    return this.queue
  }

  push(item: EngineEvent): void {
    this.queue.push(item)
  }

  end(): void {
    this.queue.end()
  }

  async send(text: string, options: SendOptions = {}): Promise<MessageId | null> {
    if (this.link.gone) return null
    try {
      const admitted = await this.link.agent.request<{ messageId: string }>(options.delivery === "queue" ? EXT.queue : EXT.steer, {
        sessionId: this.id,
        prompt: [{ type: "text", text }],
        ...(this.maxSteps === null ? {} : { maxSteps: this.maxSteps }),
      })
      return admitted.messageId as MessageId
    } catch (error) {
      if (this.link.gone) return null
      throw new Error(this.link.unavailable(error).message)
    }
  }

  interrupt(): void {
    if (this.link.gone) return
    this.link.agent.notify(methods.agent.session.cancel, { sessionId: this.id }).catch(() => {})
  }

  revert(options: SessionRevertOptions = {}): Promise<RevertResult> {
    return this.restore(EXT.revert, options)
  }

  undoRevert(options: Omit<SessionRevertOptions, "messageId"> = {}): Promise<RevertResult> {
    return this.restore(EXT.undoRevert, options)
  }

  /** The hand-edit question the server put, answered by the `confirm` of the revert in progress. */
  async ask(plan: RevertPlan): Promise<"overwrite" | "keep" | null> {
    const question = this.question
    if (question === null) return null
    const answer = await question(plan)
    return answer === "overwrite" || answer === "keep" ? answer : null
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.link.gone)
        await this.link.agent.request(methods.agent.session.close, { sessionId: this.id, _meta: { [NS]: { shutdown: true } } }).catch(() => {})
      this.end()
      await this.link.stop()
    })()
    return this.closing
  }

  lost(): string | null {
    return this.link.lost(this.id)
  }

  private async restore(method: string, options: SessionRevertOptions): Promise<RevertResult> {
    const { confirm, handEdits, messageId, dryRun } = options
    this.question = handEdits === "ask" ? (confirm ?? null) : null
    try {
      return await this.link.agent.request<RevertResult>(method, {
        sessionId: this.id,
        ...(messageId === undefined ? {} : { messageId }),
        ...(dryRun === undefined ? {} : { dryRun }),
        // The engine's own default, where the protocol's is to ask.
        handEdits: handEdits ?? "abort",
      })
    } catch (error) {
      throw new Error(this.link.unavailable(error).message)
    } finally {
      this.question = null
    }
  }
}

function childTransport(options: AcpEngineOptions): Transport {
  const env = options.env ?? process.env
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  const command = options.command ?? [process.execPath, MAIN, "acp"]
  // Only what the user should see: the server's warnings and errors.
  const level = `${brand.binary.toUpperCase()}_ACP_LOG`
  const child = Bun.spawn([...command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...env, [level]: env[level] ?? "warn" },
    // Its own process group: Ctrl-C at the terminal is the CLI's to handle (a cancel, not a shutdown).
    detached: true,
  })
  // The CLI may leave while the server still shuts down; that is the server's own business by then.
  child.unref()
  const tail: string[] = []
  const logged = forwardLog(child.stderr, (line) => {
    tail.push(line)
    if (tail.length > 5) tail.shift()
    const own = /^\S+ acp (debug|info|warn|error): (.*)$/.exec(line)
    if (own === null) return stderr(`${line}\n`)
    if (own[1] === "warn" || own[1] === "error") stderr(`${brand.binary}: ${own[2]}\n`)
  })
  const gone = child.exited.then(async (code) => {
    await logged
    const how = child.signalCode !== null ? `was killed (${child.signalCode})` : `exited with code ${code}`
    const last = tail.filter((line) => line.trim() !== "").at(-1)
    return last === undefined || code === 0 ? how : `${how}: ${last.replace(/^\S+ acp \w+: /, "")}`
  })
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      child.stdin.write(chunk)
      child.stdin.flush()
    },
    close: () => {
      child.stdin.end()
    },
  })
  return {
    stream: ndJsonStream(input, child.stdout),
    gone,
    // Not waited for: the session was let go of before, and the server finishes its shutdown on its own.
    stop: async () => {
      try {
        child.stdin.end()
      } catch {}
    },
    kill: () => child.kill("SIGTERM"),
  }
}

async function memoryTransport(options: AcpEngineOptions): Promise<Transport> {
  const { createLogger, serve } = await import("@light-harness/acp")
  const { createHarness } = await import("@light-harness/core")
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  const log = createLogger({ level: "warn", write: (line) => stderr(line.replace(/^\S+ acp (warn|error): /, `${brand.binary}: `)) })
  const harness = createHarness({ log: (line) => log.warn(line), ...options.harness })
  // Copied as JSON, as the wire would: neither side keeps a reference to the other's objects.
  const wire = () => new TransformStream<object, object>({ transform: (message, controller) => controller.enqueue(JSON.parse(JSON.stringify(message))) })
  const toClient = wire()
  const toAgent = wire()
  const served = serve(harness, { writable: toClient.writable, readable: toAgent.readable } as unknown as Stream, {
    log,
    ...(options.version === undefined ? {} : { version: options.version }),
  })
  const gone = served.done.then(() => "closed the connection")
  return {
    stream: { writable: toAgent.writable, readable: toClient.readable } as unknown as Stream,
    gone,
    stop: async () => {
      served.connection.close()
      await served.done
      await harness.close()
    },
    kill: () => served.connection.close(),
  }
}

/** Calls `line` with each line the stream carries; resolves when it ends. */
async function forwardLog(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let rest = ""
  try {
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true })
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const each of lines) line(each)
    }
  } catch {}
  if (rest !== "") line(rest)
}

/** `data[<ns>]` of a protocol error, or `null`. */
function errorData(error: unknown): { reason?: string; message?: unknown; holderPid?: unknown } | null {
  if (typeof error !== "object" || error === null || !("data" in error)) return null
  const data = (error as { data?: unknown }).data
  if (typeof data !== "object" || data === null) return null
  const value = (data as Record<string, unknown>)[NS]
  return typeof value === "object" && value !== null ? (value as { reason?: string; message?: unknown }) : null
}

function parseEventParams(raw: unknown): { sessionId: string; event: EngineEvent; replay?: boolean } {
  const value = raw as { sessionId?: unknown; event?: { type?: unknown } }
  if (typeof value?.sessionId !== "string" || typeof value.event?.type !== "string") throw new Error(`${EXT.event} without sessionId and event`)
  return raw as { sessionId: string; event: EngineEvent; replay?: boolean }
}

function startTimeout(env: Record<string, string | undefined>): number {
  const value = Number(env[START_TIMEOUT_ENV])
  return Number.isFinite(value) && value > 0 ? value : START_TIMEOUT_MS
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One consumer's queue of events, which ends once. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiting: ((result: IteratorResult<T>) => void) | null = null
  private ended = false

  push(item: T): void {
    if (this.ended) return
    const waiting = this.waiting
    this.waiting = null
    if (waiting !== null) waiting({ value: item, done: false })
    else this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    this.waiting = null
    waiting?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
