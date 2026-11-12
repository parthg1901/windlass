/**
 * The TUI as an ACP client of the harness's own server: `lh acp` in a child
 * process, over stdio, asked at `initialize` for every harness event as an
 * extension notification and for no standard updates (the TUI renders the
 * events itself, as the line-based CLI does).
 *
 * Unlike the CLI's client, one connection serves the whole TUI run: the
 * session picker lists sessions and the model picker lists models on it, and
 * switching sessions closes one and opens another without a new server.
 *
 * The server's standard error is piped and handed to `onLog` line by line,
 * so nothing it writes lands on the TUI's screen. When the child dies, the
 * open session's events end and `lost()` says how, and how to resume.
 *
 * Calls, by feature:
 * - a new session: `session/new` with `_meta[<ns>] = { model, effort }`
 * - resume (`--session`, `--continue`, the picker): `<prefix>/resolve`, then
 *   `session/load`, which replays the stored log (events marked `replay`)
 * - a message: `<prefix>/steer` or `<prefix>/queue`; Ctrl-C: `session/cancel`
 * - undo, redo: `<prefix>/revert`, `<prefix>/undo_revert`, whose hand-edit
 *   question arrives as `session/request_permission`
 * - model and effort: `session/set_config_option`
 * - compaction: `<prefix>/compact`, only when `initialize` advertises it
 */
import { type ClientConnection, PROTOCOL_VERSION, type RequestPermissionRequest, type RequestPermissionResponse, type Stream, client, methods, ndJsonStream } from "@agentclientprotocol/sdk"
import { EXT, META } from "@light-harness/acp/extensions"
import { type RevertResult, brand } from "@light-harness/core"
import { type Backend, BackendError, type BackendSession, type Delivery, type ModelChoice, type OpenSettings, type OpenTarget, type Question, type QuestionHandler, type RevertOptions, type SessionChoice, type StreamItem } from "./backend.ts"
import type { EngineEvent } from "./cli.ts"

const NS = META.capabilities
/** The compaction method, should the server offer it. */
export const COMPACT_METHOD = `${brand.extensionPrefix}/compact`
export const START_TIMEOUT_MS = 20_000
const SIGN_IN_ADVICE = "sign in with ChatGPT (`bun scripts/login.ts start` in the checkout), then try again"

export interface AcpClientOptions {
  /** The command that serves ACP on stdio, such as `[bun, .../cli/src/main.ts, "acp"]`. */
  readonly command: readonly string[]
  readonly env: Record<string, string | undefined>
  readonly version: string
  readonly startTimeoutMs?: number
}

export class AcpBackend implements Backend {
  readonly label = "acp"
  readonly restartable = true
  onQuestion: QuestionHandler = async () => null
  onLog: (line: string, level: "warn" | "error" | "info") => void = () => {}
  private link: Link | null = null
  private starting: Promise<Link> | null = null

  constructor(private readonly options: AcpClientOptions) {}

  /** Methods the server advertised at `initialize`. */
  get methods(): readonly string[] {
    return this.link?.methods ?? []
  }

  async open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession> {
    return (await this.connect()).open(target, cwd, settings)
  }

  async listSessions(cwd: string): Promise<SessionChoice[]> {
    return (await this.connect()).listSessions(cwd)
  }

  async listModels(): Promise<{ defaultModel: string; models: ModelChoice[] }> {
    return (await this.connect()).listModels()
  }

  async restart(): Promise<void> {
    const old = this.link
    this.link = null
    this.starting = null
    await old?.stop()
    await this.connect()
  }

  async stop(): Promise<void> {
    const link = this.link ?? (await this.starting?.catch(() => null)) ?? null
    this.link = null
    this.starting = null
    await link?.stop()
  }

  private async connect(): Promise<Link> {
    if (this.link !== null && !this.link.gone) return this.link
    if (this.link?.gone === true) throw new BackendError(this.link.lostText() ?? "the engine process is gone", "closed")
    this.starting ??= Link.start(this.options, {
      question: (question) => this.onQuestion(question),
      log: (line, level) => this.onLog(line, level),
    }).then(
      (link) => {
        this.link = link
        return link
      },
      (error: unknown) => {
        this.starting = null
        throw error
      },
    )
    return this.starting
  }
}

interface Hooks {
  readonly question: QuestionHandler
  readonly log: (line: string, level: "warn" | "error" | "info") => void
}

interface Gone {
  readonly how: string
  readonly said: string | null
}

class Link {
  readonly sessions = new Map<string, AcpSession>()
  private readonly early = new Map<string, StreamItem[]>()
  private stopping: Promise<void> | null = null
  lostReason: Gone | null = null
  methods: readonly string[] = []
  readonly connection: ClientConnection

  private constructor(
    private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly goneWith: Promise<Gone>,
    stream: Stream,
    private readonly hooks: Hooks,
  ) {
    this.connection = client({ name: brand.binary })
      .onNotification(EXT.event, parseEventParams, ({ params }) => this.deliver(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.answer(params))
      .onNotification("*", () => {})
      .connect(stream)
    void this.connection.closed
      .catch(() => {})
      .then(() => this.onClosed())
  }

  static async start(options: AcpClientOptions, hooks: Hooks): Promise<Link> {
    const level = `${brand.binary.toUpperCase()}_ACP_LOG`
    const child = Bun.spawn([...options.command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...options.env, [level]: options.env[level] ?? "warn" },
      // Its own process group: a Ctrl-C at the terminal is the TUI's to turn into a cancel.
      detached: true,
    })
    child.unref()
    const tail: string[] = []
    const logged = forwardLines(child.stderr, (line) => {
      tail.push(line)
      if (tail.length > 5) tail.shift()
      const own = /^\S+ acp (debug|info|warn|error): (.*)$/.exec(line)
      if (own === null) return line.trim() === "" ? undefined : hooks.log(line, "warn")
      hooks.log(own[2]!, own[1] === "error" ? "error" : own[1] === "warn" ? "warn" : "info")
    })
    const gone = child.exited.then(async (code) => {
      await logged
      const how = child.signalCode !== null ? `was killed (${child.signalCode})` : `exited with code ${code}`
      const last = tail.filter((line) => line.trim() !== "").at(-1)
      return { how, said: last === undefined || code === 0 ? null : last.replace(/^\S+ acp \w+: /, "") }
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
    const link = new Link(child, gone, ndJsonStream(input, child.stdout), hooks)
    const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const init = await Promise.race([
        link.connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { _meta: { [NS]: { events: true, updates: false } } },
          clientInfo: { name: `${brand.binary}-tui`, title: `${brand.name} TUI`, version: options.version },
        }),
        gone.then((how) => {
          throw new BackendError(`the engine process ${how.how} before it was ready${how.said === null ? "" : `: ${how.said}`}`, "closed")
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BackendError(`the engine process did not start within ${Math.round(timeoutMs / 1000)} s`, "closed")), timeoutMs)
        }),
      ])
      const offered = init.agentCapabilities?._meta?.[NS] as { notifications?: unknown; methods?: unknown } | undefined
      if (!Array.isArray(offered?.notifications) || !offered.notifications.includes(EXT.event))
        throw new BackendError(`the engine process does not send ${brand.name}'s events (${EXT.event}); it may be another version`, "closed")
      link.methods = Array.isArray(offered.methods) ? offered.methods.filter((name): name is string => typeof name === "string") : []
      return link
    } catch (error) {
      child.kill("SIGTERM")
      await link.stop()
      if (error instanceof BackendError) throw error
      throw new BackendError(`the engine process did not answer as expected: ${describe(error)}`, "closed")
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

  lostText(id?: string): string | null {
    const gone = this.lostReason
    if (gone === null) return null
    const said = gone.said === null ? "" : ` (${gone.said})`
    const resume = id === undefined ? "" : `; its work is recovered when the session is opened again: /reconnect here, or ${brand.binary} tui --session ${id}`
    return `the engine process ${gone.how}${said}${resume}`
  }

  async open(target: OpenTarget, cwd: string, settings: OpenSettings): Promise<BackendSession> {
    const meta = { [NS]: { model: settings.model, effort: settings.effort } }
    try {
      if (target.kind === "new") {
        const created = await this.agent.request(methods.agent.session.new, { cwd, mcpServers: [], _meta: meta })
        return this.attach(created.sessionId, cwd, settings)
      }
      const named = await this.agent.request<{ sessionId: string; cwd: string }>(EXT.resolve, { cwd, ...(target.kind === "resume" ? { session: target.id } : {}) })
      const session = this.attach(named.sessionId, named.cwd, settings)
      try {
        await this.agent.request(methods.agent.session.load, { sessionId: named.sessionId, cwd: named.cwd, mcpServers: [], _meta: { [NS]: { ...meta[NS], archived: true } } })
      } catch (error) {
        this.sessions.delete(named.sessionId)
        session.end()
        throw error
      }
      return session
    } catch (error) {
      throw this.failure(error)
    }
  }

  async listSessions(cwd: string): Promise<SessionChoice[]> {
    const rows: SessionChoice[] = []
    let cursor: string | undefined
    try {
      do {
        const page = await this.agent.request(methods.agent.session.list, { cwd, ...(cursor === undefined ? {} : { cursor }), _meta: { [NS]: { archived: true } } })
        for (const info of page.sessions) {
          const meta = info._meta?.[NS] as { model?: string; effort?: string | null; archived?: boolean } | undefined
          rows.push({ id: info.sessionId, title: info.title ?? null, cwd: info.cwd, updatedAt: Date.parse(info.updatedAt ?? ""), model: meta?.model ?? "", effort: meta?.effort ?? null, archived: meta?.archived === true })
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor !== undefined)
    } catch (error) {
      throw this.failure(error)
    }
    return rows
  }

  async listModels(): Promise<{ defaultModel: string; models: ModelChoice[] }> {
    try {
      const listed = await this.agent.request<{ defaultModel: string; models: { id: string; name: string; efforts: string[]; defaultEffort: string | null; contextWindow: number | null }[] }>(EXT.models, {})
      return {
        defaultModel: listed.defaultModel,
        models: listed.models.map((model) => ({ ...model, defaultEffort: model.defaultEffort ?? null, contextWindow: model.contextWindow ?? null, isDefault: model.id === listed.defaultModel })),
      }
    } catch (error) {
      throw this.failure(error)
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      for (const session of this.sessions.values()) session.end()
      this.connection.close()
      try {
        this.child.stdin.end()
      } catch {}
    })()
    return this.stopping
  }

  /** The sentence for a refusal or for the server being gone. */
  failure(error: unknown): BackendError {
    if (error instanceof BackendError) return error
    if (this.lostReason !== null) return new BackendError(this.lostText() ?? "the engine process is gone", "closed")
    const data = errorData(error)
    if (data?.reason === "auth_required") return new BackendError(`${typeof data.message === "string" ? data.message : "not signed in"} (${SIGN_IN_ADVICE})`, "auth_required")
    if (typeof data?.message === "string") return new BackendError(data.message, data.reason ?? null)
    return new BackendError(describe(error))
  }

  forget(id: string): void {
    this.sessions.delete(id)
  }

  private attach(sessionId: string, cwd: string, settings: OpenSettings): AcpSession {
    const session = new AcpSession(this, sessionId, cwd, settings.maxSteps)
    this.sessions.set(sessionId, session)
    for (const item of this.early.get(sessionId) ?? []) session.push(item)
    this.early.delete(sessionId)
    return session
  }

  private deliver(params: { sessionId: string; event: EngineEvent; replay?: boolean }): void {
    const item = { event: params.event, replay: params.replay === true }
    const session = this.sessions.get(params.sessionId)
    if (session !== undefined) return session.push(item)
    const waiting = this.early.get(params.sessionId) ?? []
    waiting.push(item)
    this.early.set(params.sessionId, waiting)
  }

  private async answer(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const tool = params.toolCall
    const detail = [
      ...(tool.content ?? []).flatMap((item) => (item.type === "content" && item.content.type === "text" ? [item.content.text] : [])),
      ...(tool.locations ?? []).map((location) => {
        const cwd = this.sessions.get(params.sessionId)?.cwd
        return `· ${cwd !== undefined && location.path.startsWith(`${cwd}/`) ? location.path.slice(cwd.length + 1) : location.path}`
      }),
    ]
    const question: Question = {
      title: tool.title ?? "The agent asks",
      detail,
      options: params.options.map((option) => ({ id: option.optionId, label: option.name, kind: option.kind.startsWith("allow") ? "allow" : option.kind.startsWith("reject") ? "reject" : "other" })),
    }
    const answer = await this.hooks.question(question).catch(() => null)
    return { outcome: answer === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: answer } }
  }

  private async onClosed(): Promise<void> {
    if (this.stopping !== null) return
    this.lostReason = await this.goneWith
    for (const session of this.sessions.values()) session.end()
  }
}

class AcpSession implements BackendSession {
  private readonly queue = new EventQueue<StreamItem>()
  private closing: Promise<void> | null = null
  readonly compact?: () => Promise<void>

  constructor(
    private readonly link: Link,
    readonly id: string,
    readonly cwd: string,
    private readonly maxSteps: number | null,
  ) {
    if (link.methods.includes(COMPACT_METHOD)) this.compact = () => this.request(COMPACT_METHOD, { sessionId: this.id }).then(() => undefined)
  }

  get events(): AsyncIterable<StreamItem> {
    return this.queue
  }

  push(item: StreamItem): void {
    this.queue.push(item)
  }

  end(): void {
    this.queue.end()
  }

  async send(text: string, delivery: Delivery): Promise<string | null> {
    if (this.link.gone) return null
    const admitted = await this.request<{ messageId: string }>(delivery === "queue" ? EXT.queue : EXT.steer, {
      sessionId: this.id,
      prompt: [{ type: "text", text }],
      ...(this.maxSteps === null ? {} : { maxSteps: this.maxSteps }),
    })
    return admitted.messageId
  }

  interrupt(): void {
    if (this.link.gone) return
    this.link.agent.notify(methods.agent.session.cancel, { sessionId: this.id }).catch(() => {})
  }

  revert(options: RevertOptions): Promise<RevertResult> {
    return this.request<RevertResult>(EXT.revert, { sessionId: this.id, ...options })
  }

  undoRevert(options: RevertOptions): Promise<RevertResult> {
    return this.request<RevertResult>(EXT.undoRevert, { sessionId: this.id, ...options })
  }

  async setConfig(id: "model" | "effort", value: string): Promise<void> {
    await this.request(methods.agent.session.setConfigOption, { sessionId: this.id, configId: id, value })
  }

  close(shutdown: boolean): Promise<void> {
    this.closing ??= (async () => {
      if (!this.link.gone) await this.link.agent.request(methods.agent.session.close, { sessionId: this.id, ...(shutdown ? { _meta: { [NS]: { shutdown: true } } } : {}) }).catch(() => {})
      this.link.forget(this.id)
      this.end()
    })()
    return this.closing
  }

  lost(): string | null {
    return this.link.lostText(this.id)
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    try {
      return (await this.link.agent.request(method as never, params as never)) as T
    } catch (error) {
      throw this.link.failure(error)
    }
  }
}

/** Calls `line` with each line of the stream; resolves when it ends. */
async function forwardLines(stream: ReadableStream<Uint8Array>, line: (text: string) => void): Promise<void> {
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

function errorData(error: unknown): { reason?: string; message?: unknown } | null {
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One consumer's queue, which ends once. */
export class EventQueue<T> implements AsyncIterable<T> {
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
