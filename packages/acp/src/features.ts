/**
 * What the server tells a client about the features the engine runs for a
 * session (MCP servers, hooks, language servers, skills, wake-ups, memory),
 * and the user's actions on them, through the engine's own client surface:
 * `EngineSession.mcp()`, `approveMcpServer`, `hooks()`, `lsp()`, `skills()`,
 * `memory()`, and `Engine.wake()`. Nothing
 * here changes the engine; it reads what the engine offers and words it for
 * a person, in the engine's own words where it has them.
 *
 * The configuration files are read only to say where a server is defined and
 * to name one the session has not started yet (servers start with a turn).
 */
import { type EngineSession, type Harness, type SessionId, brand } from "@windlass/core"
import { findConfigFiles, readConfigFile } from "../../core/src/config/load.ts"
import { type ConfigFile, mergeConfigFiles } from "../../core/src/config/schema.ts"
import { type Hook, HOOK_POINTS } from "../../core/src/hooks/config.ts"
import { type LspPlan, planLspServers } from "../../core/src/lsp/config.ts"
import type { LspServerStatus } from "../../core/src/lsp/registry.ts"
import { type McpServerConfig, resolveMcpConfig } from "../../core/src/mcp/config.ts"
import { describeProblem } from "../../core/src/memory/store.ts"
import { confirmationRequests } from "../../core/src/memory/trust.ts"
import { describeState, expiresAt, reviewReport, statesOf } from "../../core/src/memory/hygiene.ts"
import { MEMORY_KINDS, type MemoryEntry, type MemoryKind, type MemoryScope, formatExpiry, oneLine } from "../../core/src/memory/entry.ts"
import { describeTrigger } from "../../core/src/wake/record.ts"
import type {
  HookInfo,
  HooksStateResult,
  LspServerInfo,
  LspStateResult,
  McpServerInfo,
  McpStateResult,
  MemoryChangeParams,
  MemoryChangeResult,
  MemoryNote,
  MemoryStateResult,
  SkillsResult,
  WakeInfo,
  WakeListResult,
  WakeSecretResult,
} from "./extensions.ts"

// ---------------------------------------------------------------- MCP

interface ConfigView {
  readonly userFile: string
  readonly projectFile: string | null
  readonly user: ConfigFile | null
  readonly project: ConfigFile | null
  /** The servers the two files name together, as they would be resolved; empty when they cannot be. */
  readonly servers: readonly McpServerConfig[]
}

async function configView(cwd: string): Promise<ConfigView> {
  const where = await findConfigFiles({ cwd })
  const read = (path: string | null, origin: "user" | "project") => (path === null ? Promise.resolve(null) : readConfigFile(path, origin).catch(() => null))
  const [user, project] = await Promise.all([read(where.userFile, "user"), read(where.projectFile, "project")])
  let servers: readonly McpServerConfig[] = []
  try {
    servers = resolveMcpConfig(mergeConfigFiles(user, project).mcp).servers
  } catch {
    // A mistake in a file fails the next turn with the file and the key named; the listing shows what it can.
  }
  return { userFile: where.userFile, projectFile: where.projectFile, user, project, servers }
}

/** The command and its arguments, one each; `null` for a server reached at an address. */
function argvOf(config: McpServerConfig | undefined): string[] | null {
  return config?.transport.kind === "stdio" ? [config.transport.command, ...config.transport.args] : null
}

function targetOf(config: McpServerConfig): string {
  const transport = config.transport
  return transport.kind === "stdio" ? [transport.command, ...transport.args].join(" ") : transport.url
}

/** The session's servers, each with its state in words a person reads, where it is configured, and its tool count. */
export async function mcpState(session: EngineSession): Promise<McpStateResult> {
  const state = session.mcp()
  if (state === null) return { sessionId: session.id, available: false, servers: [] }
  const cwd = session.projection().session.cwd
  const files = await configView(cwd)
  const origin = (name: string): Pick<McpServerInfo, "origin" | "file"> => {
    if (files.project?.mcp?.servers?.[name] !== undefined) return { origin: "project", file: files.projectFile }
    if (files.user?.mcp?.servers?.[name] !== undefined) return { origin: "user", file: files.userFile }
    return { origin: null, file: null }
  }
  const byName = new Map(files.servers.map((config) => [config.name, config]))
  const servers: McpServerInfo[] = []
  const seen = new Set<string>()
  for (const status of state.servers) {
    seen.add(status.name)
    const config = byName.get(status.name)
    const word =
      status.state === "ready" ? "running" : status.state === "idle" || status.state === "connecting" ? "starting" : status.state === "retrying" ? "failed" : status.state === "disabled" ? "disabled" : "stopped"
    servers.push({
      name: status.name,
      state: word,
      transport: status.transport,
      target: config === undefined ? null : targetOf(config),
      argv: argvOf(config),
      tools: status.state === "ready" ? status.tools : null,
      hiddenTools: status.hiddenTools,
      error: word === "failed" || word === "stopped" ? status.error : null,
      retryInMs: status.retryInMs,
      ...origin(status.name),
      question: null,
    })
  }
  for (const question of state.awaiting) {
    seen.add(question.name)
    const config = byName.get(question.name)
    servers.push({
      name: question.name,
      state: "awaiting_approval",
      transport: config?.transport.kind ?? null,
      target: question.subject,
      // Only when the file still names the command the question is about: the arguments shown are then the ones asked about.
      argv: argvOf(config)?.join(" ") === question.subject ? argvOf(config) : null,
      tools: null,
      hiddenTools: 0,
      error: null,
      retryInMs: null,
      origin: "project",
      file: files.projectFile,
      question: { fingerprint: question.fingerprint, subject: question.subject, details: [...question.details] },
    })
  }
  // Named in a file but neither started nor waiting: turned off, or not looked at yet (servers start with a turn).
  for (const config of files.servers) {
    if (seen.has(config.name)) continue
    servers.push({
      name: config.name,
      state: config.enabled ? "not_started" : "disabled",
      transport: config.transport.kind,
      target: targetOf(config),
      argv: argvOf(config),
      tools: null,
      hiddenTools: 0,
      error: null,
      retryInMs: null,
      ...origin(config.name),
      question: null,
    })
  }
  return { sessionId: session.id, available: true, servers }
}

/** What changes about the servers that a client shows: not the countdown to the next retry, nor a process ID. */
export function mcpKey(session: EngineSession): string | null {
  const state = session.mcp()
  if (state === null) return null
  return JSON.stringify([state.servers.map((server) => [server.name, server.state, server.tools, server.error]), state.awaiting.map((question) => [question.name, question.fingerprint])])
}

// ---------------------------------------------------------------- hooks

/**
 * The hooks of a session in the order they run, each with where it is
 * defined and its state: in force, waiting for the user's approval (with the
 * engine's question, word for word), or failed. `failures` is why a hook
 * could not answer the last time it ran in this session, by fingerprint
 * (`hookFailure`, folded from `hook.ran`).
 */
export async function hooksState(session: EngineSession, failures: ReadonlyMap<string, string> = new Map()): Promise<HooksStateResult> {
  const state = session.hooks()
  if (state === null) return { sessionId: session.id, available: false, hooks: [], maxStopRounds: 0, ignored: [] }
  const files = await configView(session.projection().session.cwd)
  const waiting = new Map(state.awaiting.map((question) => [question.fingerprint, question]))
  const hooks: HookInfo[] = HOOK_POINTS.flatMap((point) => state.config[point]).map((hook: Hook) => {
    const question = hook.origin === "project" ? waiting.get(hook.fingerprint) : undefined
    const error = question === undefined ? (failures.get(hook.fingerprint) ?? null) : null
    return {
      name: hook.name,
      point: hook.point,
      state: question !== undefined ? "awaiting_approval" : error !== null ? "failed" : "in_force",
      command: hook.command,
      tools: hook.tools === null ? null : [...hook.tools],
      paths: hook.paths === null ? null : [...hook.paths],
      timeoutSeconds: hook.timeoutSeconds,
      onError: hook.onError,
      sandbox: hook.sandbox,
      origin: hook.origin,
      file: hook.origin === "project" ? files.projectFile : files.userFile,
      fingerprint: hook.fingerprint,
      error,
      question: question?.question ?? null,
    }
  })
  return { sessionId: session.id, available: true, hooks, maxStopRounds: state.config.maxStopRounds, ignored: [...state.config.ignored] }
}

/** What changes about the hooks that a client shows: which exist, which wait, and which could not answer. `null`: the engine runs none. */
export function hooksKey(session: EngineSession, failures: ReadonlyMap<string, string>): string | null {
  const state = session.hooks()
  if (state === null) return null
  const all = HOOK_POINTS.flatMap((point) => state.config[point])
  return JSON.stringify([all.map((hook) => [hook.id, hook.fingerprint, failures.get(hook.fingerprint) ?? null]), state.awaiting.map((question) => question.fingerprint)])
}

/** The key of a session with no hooks: what a session is taken to have until it is first looked at. */
export const NO_HOOKS_KEY = JSON.stringify([[], []])

/**
 * What a `hook.ran` record says about whether the hook can answer: why it
 * could not (`failed`), `null` when it answered, `undefined` when the record
 * says nothing about that (skipped, interrupted).
 */
export function hookFailure(record: { readonly answer: string; readonly failure: string | null; readonly detail: string | null }): string | null | undefined {
  if (record.answer === "failed") return record.detail ?? record.failure?.replace(/_/g, " ") ?? "it failed"
  return record.answer === "yes" || record.answer === "no" ? null : undefined
}

// ---------------------------------------------------------------- language servers

const PROCESS_WORDS: Record<LspServerStatus["state"], LspServerInfo["processes"][number]["state"]> = { idle: "not_started", starting: "starting", ready: "running", retrying: "failed", stopped: "stopped" }

/** The plan the two files give, without the approvals (the engine says which servers wait); `null` when neither names a server or they cannot be resolved. */
function lspPlan(files: ConfigView): LspPlan | null {
  if (files.user?.lsp === undefined && files.project?.lsp === undefined) return null
  try {
    return planLspServers(files.user?.lsp, files.project?.lsp, () => true)
  } catch {
    return null
  }
}

/**
 * The session's language servers: every one a file names, with the files it
 * serves and where it is defined, and its state as the engine reports it
 * (one process per workspace root; the server's state is the one that most
 * needs the user's eye).
 */
export async function lspState(session: EngineSession): Promise<LspStateResult> {
  const state = session.lsp()
  const files = await configView(session.projection().session.cwd)
  const plan = lspPlan(files)
  const config = plan?.config ?? null
  const off =
    config === null
      ? null
      : !config.enabled
        ? `Diagnostics are off: "lsp": { "enabled": false } in the configuration. No server is started.`
        : config.waitMs === 0
          ? `Diagnostics are off: "lsp": { "waitMs": 0 } in the configuration lets an edit wait no time for them. No server is started.`
          : null
  // The engine holds nothing although the files name servers that could run: it offers no diagnostics.
  const available = state !== null || plan === null || off !== null || !plan.servers.some((server) => server.config.enabled)
  const waiting = new Map((state?.awaiting ?? []).map((question) => [question.name, question]))
  const servers: LspServerInfo[] = (plan?.servers ?? []).map((server) => {
    const name = server.config.name
    const question = waiting.get(name)
    const processes = (state?.servers ?? []).filter((status) => status.server === name).map((status) => ({ root: status.root, state: PROCESS_WORDS[status.state], error: status.error, restarts: status.restarts, openDocuments: status.openDocuments }))
    const first = (word: LspServerInfo["processes"][number]["state"]) => processes.find((process) => process.state === word)
    const shown = first("failed") ?? first("starting") ?? first("running") ?? first("stopped")
    return {
      name,
      state: !server.config.enabled ? "disabled" : question !== undefined ? "awaiting_approval" : (shown?.state ?? "not_started"),
      command: question?.subject ?? [server.config.command, ...server.config.args].join(" "),
      // Only when the file still holds the definition the question is about (its fingerprint): the arguments shown are then the ones asked about.
      argv: question === undefined || question.fingerprint === server.fingerprint ? [server.config.command, ...server.config.args] : null,
      languages: server.config.languages.map((language) => ({ languageId: language.languageId, patterns: [...language.patterns] })),
      processes,
      error: shown?.state === "failed" || shown?.state === "stopped" ? shown.error : null,
      origin: server.origin,
      file: server.origin === "project" ? files.projectFile : files.userFile,
      question: question === undefined ? null : { fingerprint: question.fingerprint, subject: question.subject, details: [...question.details] },
    }
  })
  return { sessionId: session.id, available, off, waitMs: config?.waitMs ?? null, servers }
}

/** What changes about the language servers that a client shows: not a process ID or a count of open files. `null`: none could give diagnostics. */
export function lspKey(session: EngineSession): string | null {
  const state = session.lsp()
  if (state === null) return null
  return JSON.stringify([state.servers.map((server) => [server.server, server.root, server.state, server.error]), state.awaiting.map((question) => [question.name, question.fingerprint])])
}

/** The key of a session whose language servers have not started and do not wait. */
export const NO_LSP_KEY = JSON.stringify([[], []])

// ---------------------------------------------------------------- skills

export function skillsState(session: EngineSession): SkillsResult {
  const set = session.skills()
  if (set === null) return { sessionId: session.id, available: false, skills: [], problems: [], roots: [] }
  return {
    sessionId: session.id,
    available: true,
    skills: set.skills.map((skill) => ({ name: skill.name, description: skill.description, path: skill.path, scope: skill.root.scope, root: skill.root.dir })),
    problems: set.problems.map((problem) => ({ path: problem.path, severity: problem.severity, reason: problem.reason })),
    roots: set.roots.map((root) => ({ dir: root.dir, scope: root.scope })),
  }
}

// ---------------------------------------------------------------- wake-ups

export function wakeList(harness: Harness, sessionId: string): WakeListResult {
  const api = harness.engine.wake()
  if (api === null) return { sessionId, available: false, running: false, wakeups: [] }
  const wakes = api.store.list({ sessionId, includeEnded: true })
  const wakeups: WakeInfo[] = wakes.map((wake) => ({
    id: wake.id,
    trigger: wake.trigger.kind,
    description: describeTrigger(wake.trigger),
    state: wake.state.kind,
    nextAt: wake.nextAt === null ? null : new Date(wake.nextAt).toISOString(),
    fired: wake.fired,
    maxFirings: wake.limits.maxFirings,
    author: wake.provenance.author,
    message: wake.message,
    url: wake.trigger.kind === "webhook" ? api.webhookUrl(wake.id) : null,
    lines: api.describe(wake),
  }))
  return { sessionId, available: true, running: api.running, wakeups }
}

export function wakeCancel(harness: Harness, sessionId: string, id: string): { readonly cancelled: boolean; readonly message: string } {
  const api = harness.engine.wake()
  if (api === null) return { cancelled: false, message: "this engine has no wake-ups" }
  const wake = api.store.get(id)
  if (wake === null || wake.sessionId !== sessionId) return { cancelled: false, message: `there is no wake-up ${id} in this session` }
  const result = api.store.cancel(id, { by: "user", sessionId })
  if (!result.ok) return { cancelled: false, message: result.error }
  api.changed()
  return { cancelled: true, message: `Cancelled wake-up ${id} (${describeTrigger(wake.trigger)}).` }
}

/** A webhook wake-up's URL and secret, for the user. Never sent as an event or logged: only as this answer. */
export function wakeSecret(harness: Harness, sessionId: string, id: string): WakeSecretResult {
  const api = harness.engine.wake()
  if (api === null) return { id, url: null, secret: null, message: "this engine has no wake-ups" }
  const wake = api.store.get(id)
  if (wake === null || wake.sessionId !== sessionId) return { id, url: null, secret: null, message: `there is no wake-up ${id} in this session` }
  if (wake.trigger.kind !== "webhook") return { id, url: null, secret: null, message: `${id} is not a webhook wake-up (${describeTrigger(wake.trigger)}): it has no secret` }
  return { id, url: api.webhookUrl(id), secret: api.store.secret(id), message: null }
}

// ---------------------------------------------------------------- memory

const ON = `{ "memory": { "enabled": true } }`

export async function memoryState(session: EngineSession): Promise<MemoryStateResult> {
  const memory = session.memory()
  if (memory === null) {
    const files = await configView(session.projection().session.cwd)
    const on = files.user?.memory?.enabled === true || files.project?.memory?.enabled === true
    const started = session.projection().baseline !== null
    const off = !on
      ? `Memory is off. To turn it on, put ${ON} in ${files.userFile}; sessions started after that have it.`
      : started
        ? `Memory is on in the configuration, but this session was started while it was off, so it has none; start a new session (${brand.binary}) to use it.`
        : "Memory is on in the configuration; this session's notes are read when it starts its first turn. Send a message, then try again."
    return { sessionId: session.id, enabled: false, off, notes: [], pending: [], problems: [], review: [], paths: null }
  }
  const { store } = memory
  const loaded = store.load()
  const now = new Date()
  const states = statesOf(loaded.entries, now)
  const notes: MemoryNote[] = loaded.entries
    .filter((entry) => {
      const state = states.get(entry.id)?.state
      return state === "active" || state === "expired" || state === "superseded"
    })
    .map((entry) => noteOf(entry, describeState(states.get(entry.id)!)))
  return {
    sessionId: session.id,
    enabled: true,
    off: null,
    notes,
    pending: confirmationRequests(loaded.entries).map((request) => ({ ...request, decisions: [...request.decisions] })),
    problems: loaded.problems.map((problem) => ({ path: problem.path, message: describeProblem(problem) })),
    review: reviewReport(loaded.entries, loaded.problems, now).map((item) => ({ ...item })),
    paths: { user: store.paths.user, project: store.paths.project },
  }
}

function noteOf(entry: MemoryEntry, state: string): MemoryNote {
  return {
    id: entry.id,
    kind: entry.kind,
    scope: entry.scope,
    text: oneLine(entry.text),
    state,
    author: entry.provenance.author,
    quote: entry.provenance.quote,
    created: entry.created,
    confirmed: entry.confirmed,
    expires: formatExpiry(entry.expires),
  }
}

/** The user's own action on a note: remember, retract, confirm, reject, renew. */
export function memoryChange(session: EngineSession, params: MemoryChangeParams): MemoryChangeResult {
  const memory = session.memory()
  if (memory === null) return { ok: false, message: "Memory is off in this session: /memory says how to turn it on.", id: null }
  const { store } = memory
  switch (params.action) {
    case "remember": {
      const text = (params.text ?? "").trim()
      if (text === "") return { ok: false, message: "Nothing to remember: give the note's text.", id: null }
      const scope: MemoryScope = params.scope ?? "project"
      const kind: MemoryKind = params.kind ?? (scope === "user" ? "preference" : "fact")
      const saved = store.save({
        text,
        kind,
        scope,
        status: "active",
        provenance: { author: "user", session: session.id, message: null, call: null, seq: null, quote: null, untrusted: false },
      })
      if (saved.outcome === "saved")
        return { ok: true, id: saved.entry.id, message: `Saved ${saved.entry.id} (${kind}, ${scope === "user" ? "about you, for every project" : "for this project"}): later sessions are given it. File: ${saved.path}` }
      if (saved.outcome === "merged") return { ok: true, id: saved.entry.id, message: saved.reason }
      return { ok: false, id: saved.conflict, message: saved.reason }
    }
    case "retract":
    case "confirm":
    case "reject":
    case "renew": {
      const id = params.id ?? ""
      if (id === "") return { ok: false, message: `/${params.action === "retract" ? "forget" : `memory ${params.action}`} needs a note's ID (m_...)`, id: null }
      const result =
        params.action === "retract" ? store.retract(id, "user", params.reason ?? null) : params.action === "renew" ? store.renew(id) : store.decide(id, params.action)
      if (!result.ok) return { ok: false, id, message: result.reason }
      const done =
        params.action === "retract"
          ? "retracted: no later session is given it (the file is kept)"
          : params.action === "renew"
            ? `renewed: confirmed today${lapses(result.entry)}`
            : params.action === "confirm"
              ? "confirmed: later sessions are given it"
              : "rejected: no session is given it"
      return { ok: true, id, message: `${id} ${done}.` }
    }
  }
}

function lapses(entry: MemoryEntry): string {
  const at = expiresAt(entry)
  return at === null ? ", it never lapses" : `, it lapses ${at.toISOString().slice(0, 10)} unless renewed again`
}

export function memoryKind(value: unknown): MemoryKind | undefined {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : undefined
}

export type { SessionId }
