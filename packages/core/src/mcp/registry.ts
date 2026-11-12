/**
 * The configured MCP servers of one process: starting them in the background,
 * keeping them connected, and answering for them.
 *
 * - `start()` returns at once. Each server connects on its own; a slow or
 *   broken server delays nothing and changes nothing but the catalogue.
 * - A server that fails to start, or exits, is retried with exponential
 *   backoff and jitter. The count of failures resets once a connection has
 *   stayed up for `stableMs`, so a server that crashes at once keeps backing off.
 * - What the catalogue shows is the published view: a server is published
 *   when it is ready, and withdrawn only after it has been unavailable for
 *   `dropAfterMs`. A crash followed by a quick restart with the same tools
 *   therefore changes nothing the model sees.
 * - `stop()` closes every session and stops every started process group.
 *
 * The registry never touches a tool list or a store. The bridge tools read
 * it, and the engine reads `catalogue()` at step boundaries.
 */
import { resolve } from "node:path"
import type { Json } from "../json.ts"
import { type CatalogueServer, catalogueSource, stableJson } from "./catalogue.ts"
import type { Channel } from "./channel.ts"
import { type McpSession, openSession } from "./client.ts"
import { type McpServerConfig, expandVariables, serverEnvironment, toolAllowed } from "./config.ts"
import { openHttpChannel } from "./http.ts"
import { type JsonObject, type McpCallResult, McpError, type McpToolDefinition, excerpt } from "./protocol.ts"
import { checkArguments, editDistance } from "./schema.ts"
import { openStdioChannel } from "./stdio.ts"

export interface McpRegistryOptions {
  readonly servers: readonly McpServerConfig[]
  /** The session's working directory: where a server starts unless it names its own `cwd`. */
  readonly cwd: string
  /** The harness's environment, for `${NAME}` and the base variables. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number; readonly stableMs?: number }
  /** How long an unavailable server stays in the catalogue. Default 30 s. */
  readonly dropAfterMs?: number
  /** stdio: how long the era probe waits before also sending `initialize`. Default 2000 ms. */
  readonly probeMs?: number
  /** stdio: grace period after closing stdin and again after SIGTERM. Default 2000 ms. */
  readonly graceMs?: number
  /** Jitter source in [0, 1). Default `Math.random`. */
  readonly random?: () => number
  /** Things worth logging that no caller asked about (a rejected tool, a failed refresh). */
  readonly onDiagnostic?: (server: string, message: string) => void
}

export type ServerState = "disabled" | "idle" | "connecting" | "ready" | "retrying" | "stopped"

export interface ServerStatus {
  readonly name: string
  readonly transport: "stdio" | "http"
  readonly state: ServerState
  readonly era: "modern" | "legacy" | null
  readonly protocolVersion: string | null
  /** The name the server gives itself. Self-reported; for display only. */
  readonly serverInfo: string | null
  readonly tools: number
  /** Tools the configuration's allow or deny list hides. */
  readonly hiddenTools: number
  readonly rejectedTools: readonly { readonly name: string | null; readonly reason: string }[]
  /** Why the last attempt failed or the last connection ended, with what the server wrote to stderr. */
  readonly error: string | null
  readonly retryInMs: number | null
  readonly pid: number | null
}

/** The outcome of one call through the registry, before the bridge renders it. */
export type McpCallOutcome =
  | { readonly kind: "result"; readonly server: string; readonly tool: string; readonly untrusted: boolean; readonly result: McpCallResult }
  /** The call was not sent: the text says what to fix. `untrusted`: it quotes what an untrusted server wrote (its stderr). */
  | { readonly kind: "refused"; readonly message: string; readonly untrusted?: boolean }
  /**
   * Sent, and no result came back. `serverText` says whether `message`
   * contains text the server produced (its error message).
   */
  | { readonly kind: "failed"; readonly server: string; readonly tool: string; readonly untrusted: boolean; readonly message: string; readonly serverText: boolean }

export interface McpCallRequest {
  readonly server: string
  readonly tool: string
  readonly arguments: JsonObject
  readonly signal: AbortSignal
  readonly onProgress?: (text: string) => void
}

export interface McpRegistry {
  /** Starts connecting every enabled server in the background. Returns at once. Idempotent. */
  start(): void
  /** Closes every session and stops every server process. Idempotent. */
  stop(): Promise<void>
  status(): ServerStatus[]
  /** The published view: the servers the catalogue shows, with their tools. */
  servers(): CatalogueServer[]
  /** The catalogue as an instruction source, or `null` when no server offers tools. */
  catalogue(): { readonly key: string; readonly value: string } | null
  call(request: McpCallRequest): Promise<McpCallOutcome>
  /** Called whenever the published view changes. Returns the function that removes the listener. */
  onChange(listener: () => void): () => void
  /**
   * Called whenever what `status()` returns may have changed: a server's
   * state, its tools, its error. Not for the countdown to a retry
   * (`retryInMs`), which changes with the clock. Returns the function that
   * removes the listener.
   */
  onStatus(listener: () => void): () => void
  /** Resolves once every enabled server has connected or failed at least once (for demos and tests), or after `timeoutMs`. */
  settled(timeoutMs?: number): Promise<void>
}

interface Managed {
  readonly config: McpServerConfig
  state: ServerState
  session: McpSession | null
  channel: Channel | null
  /** The tools the configuration allows, in the server's order. */
  tools: McpToolDefinition[]
  /** Every name the server listed, allowed or not, to explain a hidden tool. */
  listed: Set<string>
  rejected: { name: string | null; reason: string }[]
  error: string | null
  failures: number
  retryAt: number | null
  everSettled: boolean
  wake: (() => void) | null
  dropTimer: ReturnType<typeof setTimeout> | null
  refreshing: boolean
  refreshAgain: boolean
  readonly waiters: Set<() => void>
}

export function createMcpRegistry(options: McpRegistryOptions): McpRegistry {
  const env = options.env ?? process.env
  const initialMs = options.backoff?.initialMs ?? 1000
  const maxMs = options.backoff?.maxMs ?? 5 * 60_000
  const stableMs = options.backoff?.stableMs ?? 30_000
  const dropAfterMs = options.dropAfterMs ?? 30_000
  const random = options.random ?? Math.random
  const diagnose = options.onDiagnostic ?? (() => {})

  const managed = new Map<string, Managed>(
    options.servers.map((config) => [
      config.name,
      {
        config,
        state: config.enabled ? "idle" : "disabled",
        session: null,
        channel: null,
        tools: [],
        listed: new Set(),
        rejected: [],
        error: null,
        failures: 0,
        retryAt: null,
        everSettled: !config.enabled,
        wake: null,
        dropTimer: null,
        refreshing: false,
        refreshAgain: false,
        waiters: new Set(),
      } satisfies Managed,
    ]),
  )
  if (managed.size !== options.servers.length) throw new Error("MCP server names must be unique")
  const published = new Map<string, CatalogueServer>()
  const listeners = new Set<() => void>()
  const statusListeners = new Set<() => void>()
  const loops: Promise<void>[] = []
  const stopController = new AbortController()
  let started = false
  let stopping: Promise<void> | null = null

  const emit = () => {
    for (const listener of [...listeners]) listener()
  }
  /** The status changed: a listener's failure is not the registry's. */
  const touched = () => {
    for (const listener of [...statusListeners]) {
      try {
        listener()
      } catch {
        // Whoever listens says what went wrong on its side.
      }
    }
  }
  const setState = (m: Managed, state: ServerState) => {
    m.state = state
    for (const waiter of [...m.waiters]) waiter()
    touched()
  }
  const publish = (m: Managed) => {
    if (m.dropTimer !== null) clearTimeout(m.dropTimer)
    m.dropTimer = null
    published.set(m.config.name, {
      name: m.config.name,
      untrusted: m.config.untrusted,
      instructions: m.session?.instructions ?? null,
      tools: m.tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })),
    })
    emit()
    touched()
  }
  const scheduleDrop = (m: Managed) => {
    if (!published.has(m.config.name) || m.dropTimer !== null) return
    m.dropTimer = setTimeout(() => {
      m.dropTimer = null
      if (stopController.signal.aborted || m.state === "ready") return
      published.delete(m.config.name)
      emit()
    }, dropAfterMs)
  }
  const applyListing = (m: Managed, listing: { tools: readonly McpToolDefinition[]; rejected: readonly { name: string | null; reason: string }[] }) => {
    m.listed = new Set(listing.tools.map((tool) => tool.name))
    m.tools = listing.tools.filter((tool) => toolAllowed(tool.name, m.config.tools))
    m.rejected = [...listing.rejected]
    for (const entry of listing.rejected) diagnose(m.config.name, `tool ${entry.name === null ? "(unnamed)" : JSON.stringify(entry.name)} is not usable: ${entry.reason}`)
  }

  const connect = async (m: Managed): Promise<{ ok: true; session: McpSession; channel: Channel } | { ok: false; reason: string }> => {
    const startupMs = m.config.startupTimeoutSeconds * 1000
    const controller = new AbortController()
    const onStop = () => controller.abort(new Error("the harness is shutting down"))
    stopController.signal.addEventListener("abort", onStop, { once: true })
    const timer = setTimeout(() => controller.abort(new Error(`did not finish starting within ${m.config.startupTimeoutSeconds} s`)), startupMs)
    let channel: Channel | null = null
    try {
      const opened = openChannel(m.config, options.cwd, env, options.graceMs)
      if (!opened.ok) return { ok: false, reason: opened.reason }
      channel = opened.channel
      m.channel = channel
      // A process that dies during start-up rejects the pending request; the race makes sure nothing waits longer.
      const session = await openSession(channel, { signal: controller.signal, protocol: m.config.protocol, probeMs: options.probeMs })
      const listing = await session.listTools(controller.signal)
      applyListing(m, listing)
      return { ok: true, session, channel }
    } catch (error) {
      const reason = controller.signal.aborted
        ? controller.signal.reason instanceof Error
          ? controller.signal.reason.message
          : "start-up was abandoned"
        : error instanceof Error
          ? error.message
          : String(error)
      const details = channel === null ? "" : describeChannel(channel)
      await channel?.close()
      m.channel = null
      return { ok: false, reason: `${reason}${details}` }
    } finally {
      clearTimeout(timer)
      stopController.signal.removeEventListener("abort", onStop)
    }
  }

  const sleepBackoff = async (m: Managed) => {
    const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, m.failures - 1))
    const delay = Math.round(base * (0.75 + 0.5 * random()))
    m.retryAt = Date.now() + delay
    setState(m, "retrying")
    await new Promise<void>((done) => {
      const timer = setTimeout(done, delay)
      m.wake = () => {
        clearTimeout(timer)
        done()
      }
    })
    m.wake = null
    m.retryAt = null
  }

  const refresh = async (m: Managed, session: McpSession) => {
    if (m.refreshing) {
      m.refreshAgain = true
      return
    }
    m.refreshing = true
    try {
      do {
        m.refreshAgain = false
        try {
          const listing = await session.listTools(AbortSignal.any([AbortSignal.timeout(m.config.startupTimeoutSeconds * 1000), stopController.signal]))
          if (m.session !== session) return
          applyListing(m, listing)
          publish(m)
        } catch (error) {
          if (m.session !== session || stopController.signal.aborted) return
          diagnose(m.config.name, `could not refresh the tool list: ${error instanceof Error ? error.message : String(error)}`)
        }
      } while (m.refreshAgain && m.session === session)
    } finally {
      m.refreshing = false
    }
  }

  const run = async (m: Managed) => {
    while (!stopController.signal.aborted) {
      setState(m, "connecting")
      const attempt = await connect(m)
      if (stopController.signal.aborted) {
        if (attempt.ok) await attempt.session.close()
        return
      }
      if (!attempt.ok) {
        m.failures += 1
        m.error = attempt.reason
        m.everSettled = true
        await sleepBackoff(m)
        continue
      }
      const session = attempt.session
      m.session = session
      m.error = null
      m.everSettled = true
      const connectedAt = performance.now()
      setState(m, "ready")
      publish(m)
      session.watchTools(() => void refresh(m, session))
      const reason = await session.closed
      m.session = null
      if (stopController.signal.aborted) return
      // Not ready from this moment on, before the channel's cleanup is awaited.
      setState(m, "retrying")
      m.error = `${reason}${describeChannel(attempt.channel)}`
      m.channel = null
      touched()
      await attempt.channel.close()
      if (performance.now() - connectedAt >= stableMs) m.failures = 0
      m.failures += 1
      scheduleDrop(m)
      await sleepBackoff(m)
    }
  }

  /** Waits until the server is ready or has failed, or until `timeoutMs` or the signal. */
  const waitReady = (m: Managed, signal: AbortSignal, timeoutMs: number) =>
    new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer)
        m.waiters.delete(check)
        signal.removeEventListener("abort", finish)
        done()
      }
      const check = () => {
        if (m.state !== "connecting" && m.state !== "idle") finish()
      }
      const timer = setTimeout(finish, timeoutMs)
      signal.addEventListener("abort", finish, { once: true })
      m.waiters.add(check)
      check()
    })

  const statusOf = (m: Managed): ServerStatus => ({
    name: m.config.name,
    transport: m.config.transport.kind,
    state: m.state,
    era: m.session?.era ?? null,
    protocolVersion: m.session?.protocolVersion ?? null,
    serverInfo: m.session?.serverInfo === null || m.session === null ? null : `${m.session.serverInfo.name} ${m.session.serverInfo.version}`.trim(),
    tools: m.tools.length,
    hiddenTools: m.listed.size - m.tools.length,
    rejectedTools: m.rejected,
    error: m.error,
    retryInMs: m.retryAt === null ? null : Math.max(0, m.retryAt - Date.now()),
    pid: m.channel?.diagnostics().pid ?? null,
  })

  return {
    start: () => {
      if (started || stopController.signal.aborted) return
      started = true
      for (const m of managed.values()) if (m.config.enabled) loops.push(run(m))
    },

    stop: () => {
      stopping ??= (async () => {
        stopController.abort(new Error("the harness is shutting down"))
        for (const m of managed.values()) {
          if (m.dropTimer !== null) clearTimeout(m.dropTimer)
          m.wake?.()
        }
        await Promise.all([...managed.values()].map((m) => (m.session?.close() ?? m.channel?.close())?.catch(() => {})))
        await Promise.all(loops)
        for (const m of managed.values()) {
          m.session = null
          m.channel = null
          if (m.config.enabled) setState(m, "stopped")
        }
      })()
      return stopping
    },

    status: () => [...managed.values()].map(statusOf),
    servers: () => [...published.values()],
    catalogue: () => catalogueSource([...published.values()]),

    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    settled: (timeoutMs = 60_000) =>
      new Promise<void>((done) => {
        const deadline = Date.now() + timeoutMs
        const poll = () => {
          if ([...managed.values()].every((m) => m.everSettled) || Date.now() > deadline || stopController.signal.aborted) return done()
          setTimeout(poll, 20)
        }
        poll()
      }),

    call: async (request) => {
      const m = managed.get(request.server)
      if (m === undefined) return { kind: "refused", message: unknownServer(request.server, [...managed.keys()]) }
      const label = `${request.server}/${request.tool}`
      if (m.state === "disabled") return { kind: "refused", message: `The MCP server ${request.server} is disabled in the configuration.` }
      if (stopController.signal.aborted) return { kind: "refused", message: "The MCP servers have been shut down." }
      if (m.state === "connecting" || m.state === "idle") await waitReady(m, request.signal, m.config.startupTimeoutSeconds * 1000)
      const session = m.session
      if (m.state !== "ready" || session === null) return { kind: "refused", message: unavailable(m), untrusted: m.config.untrusted && m.error !== null }
      const tool = m.tools.find((candidate) => candidate.name === request.tool)
      if (tool === undefined) {
        if (m.listed.has(request.tool))
          return { kind: "refused", message: `The tool ${label} is not allowed by the configuration of the MCP server ${request.server}.` }
        return { kind: "refused", message: unknownTool(request.server, request.tool, m.tools, managed) }
      }
      const issues = checkArguments(tool.inputSchema, request.arguments)
      if (issues.length > 0) return { kind: "refused", message: invalidArguments(label, issues, tool.inputSchema) }

      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new Error(`timed out after ${m.config.timeoutSeconds} s`)), m.config.timeoutSeconds * 1000)
      const base = { server: request.server, tool: request.tool, untrusted: m.config.untrusted }
      try {
        const result = await session.callTool(tool, request.arguments, {
          signal: AbortSignal.any([request.signal, timeout.signal, stopController.signal]),
          onProgress: request.onProgress,
        })
        return { kind: "result", ...base, result }
      } catch (error) {
        const failed = (message: string, serverText = false) => ({ kind: "failed" as const, ...base, message, serverText })
        if (request.signal.aborted)
          return failed(`Interrupted: the call to ${label} was cancelled. The server was asked to stop; it may or may not have finished the work.`)
        if (timeout.signal.aborted)
          return failed(
            `The call to ${label} timed out after ${m.config.timeoutSeconds} s and was cancelled. It may or may not have taken effect; check before calling it again.`,
          )
        if (stopController.signal.aborted) return failed(`The call to ${label} was stopped because the harness is shutting down.`)
        if (error instanceof McpError && error.kind === "rpc")
          return failed(`The MCP server ${request.server} rejected the call to ${label}: ${error.rpc?.code ?? ""} ${error.message}`.replace("  ", " "), true)
        if (error instanceof McpError && (error.kind === "closed" || error.kind === "transport"))
          return failed(
            `The MCP server ${request.server} stopped during the call to ${label} (${error.message}). It is restarted automatically. The call may or may not have taken effect; check before calling it again.`,
          )
        return failed(`The call to ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

function openChannel(
  config: McpServerConfig,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  graceMs: number | undefined,
): { ok: true; channel: Channel } | { ok: false; reason: string } {
  const transport = config.transport
  if (transport.kind === "stdio") {
    const childEnv = serverEnvironment(transport.env, env)
    if (!childEnv.ok) return { ok: false, reason: `the environment variable ${childEnv.missing} named in its env is not set` }
    try {
      return {
        ok: true,
        channel: openStdioChannel({
          command: transport.command,
          args: transport.args,
          cwd: resolve(cwd, transport.cwd ?? "."),
          env: childEnv.env,
          graceMs,
        }),
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const headers: Record<string, string> = {}
  for (const [key, raw] of Object.entries(transport.headers)) {
    const expanded = expandVariables(raw, env)
    if (!expanded.ok) return { ok: false, reason: `the environment variable ${expanded.missing} named in its headers is not set` }
    headers[key] = expanded.value
  }
  return { ok: true, channel: openHttpChannel({ url: transport.url, headers }) }
}

function describeChannel(channel: Channel): string {
  const diagnostics = channel.diagnostics()
  const parts: string[] = []
  if (diagnostics.garbageLines > 0)
    parts.push(
      `it wrote ${diagnostics.garbageLines} line${diagnostics.garbageLines === 1 ? "" : "s"} to stdout that ${diagnostics.garbageLines === 1 ? "is" : "are"} not MCP messages, e.g. ${JSON.stringify(diagnostics.garbageSamples[0] ?? "")}`,
    )
  const stderr = diagnostics.stderrTail.trim()
  if (stderr !== "") parts.push(`stderr ends with: ${excerpt(stderr.split("\n").slice(-3).join(" | "), 300)}`)
  return parts.length === 0 ? "" : `; ${parts.join("; ")}`
}

function unavailable(m: Managed): string {
  const name = m.config.name
  if (m.state === "connecting" || m.state === "idle") return `The MCP server ${name} is still starting. Try again shortly.`
  if (m.state === "stopped") return `The MCP server ${name} has been shut down.`
  const retry = m.retryAt === null ? "" : ` The harness retries in ${Math.max(1, Math.ceil((m.retryAt - Date.now()) / 1000))} s.`
  return `The MCP server ${name} is not running: ${m.error ?? "it is unavailable"}.${retry}`
}

function unknownServer(name: string, known: readonly string[]): string {
  if (known.length === 0) return "No MCP servers are configured."
  const close = closeMatches(name, known)
  return `There is no MCP server named ${JSON.stringify(name)}.${close.length > 0 ? ` Did you mean ${close.map((c) => JSON.stringify(c)).join(" or ")}?` : ""} Servers: ${[...known].sort().join(", ")}.`
}

function unknownTool(server: string, tool: string, tools: readonly McpToolDefinition[], managed: ReadonlyMap<string, Managed>): string {
  const names = tools.map((candidate) => candidate.name)
  const close = closeMatches(tool, names)
  const elsewhere = [...managed.values()].filter((m) => m.config.name !== server && m.tools.some((candidate) => candidate.name === tool)).map((m) => m.config.name)
  const hints = [
    close.length > 0 ? `Close matches on ${server}: ${close.join(", ")}.` : "",
    elsewhere.length > 0 ? `A tool with that name is on ${elsewhere.sort().join(", ")}.` : "",
    "Use mcp_search to find tools.",
  ].filter((hint) => hint !== "")
  return `The MCP server ${server} has no tool named ${JSON.stringify(tool)}. ${hints.join(" ")}`
}

function invalidArguments(label: string, issues: readonly { path: string; message: string }[], schema: Json): string {
  const lines = issues.slice(0, 8).map((issue) => `- ${issue.path === "" ? "arguments" : `arguments.${issue.path}`}: ${issue.message}`)
  if (issues.length > 8) lines.push(`- and ${issues.length - 8} more`)
  const shown = stableJson(schema)
  return [`Invalid arguments for ${label} (not sent):`, ...lines, `Its input schema: ${shown.length > 4000 ? `${shown.slice(0, 4000)}…` : shown}`, `Fix the arguments and call mcp_call again.`].join("\n")
}

function closeMatches(name: string, candidates: readonly string[]): string[] {
  const lower = name.toLowerCase()
  return candidates
    .map((candidate) => ({ candidate, distance: editDistance(lower, candidate.toLowerCase()) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(entry.candidate.length / 3)) || entry.candidate.toLowerCase().includes(lower))
    .sort((a, b) => a.distance - b.distance || (a.candidate < b.candidate ? -1 : 1))
    .slice(0, 3)
    .map((entry) => entry.candidate)
}
