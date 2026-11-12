/**
 * Language-server diagnostics, as the step loop offers them (`lsp/` has the
 * module).
 *
 * - Nothing of it is in a request: no tool, no spec and no system-prompt
 *   text depends on which servers are configured. What a server says reaches
 *   the model as a short note after the result of the edit it is about,
 *   added before that result is capped and stored, so it is frozen with it.
 * - After a successful read of a file a server serves, the file is shown to
 *   the server (`observe`), which never waits. After a successful `edit` or
 *   `write` of one, the servers are asked what the edit made worse
 *   (`diagnose`), which returns within the configured bound whatever the
 *   servers do. The loop adds no wait of its own and never tries again.
 * - What the servers said is recorded with the result, as fields
 *   (`tool.settled.diagnostics`). A replay replays the stored text and
 *   starts no server.
 *
 * **Who may start a server.** As for MCP servers (`engine/mcp.ts`): a server
 * the user's own file defines is the user's; one the project's file names,
 * or changes in any field, waits until the user approved exactly that
 * definition. The approval is a remembered approval for the project (a
 * `tool` rule that names the server and its fingerprint, 30 days).
 *
 * **Lifetime.** The engine has one hub. It holds one registry per working
 * directory and configuration, shared by the sessions that work there,
 * created when the first of them reads its configuration (which starts
 * nothing: a server starts at the first file it serves) and stopped when
 * the last lets go, or when the engine closes.
 */
import { readFileSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { type Grant, PROJECT_GRANT_TTL_MS } from "../approval/grants.ts"
import { quotedCommand } from "../command-line.ts"
import type { DiagnosticsRecord } from "../event/durable.ts"
import { type LspPlan, type LspServerQuestion, lspApprovalKey, planLspServers, stableJson } from "../lsp/config.ts"
import { type DiagnoseResult, type LspNotice, type LspRegistry, type LspRegistryOptions, type LspServerStatus, MAX_DOCUMENT_CHARS, createLspRegistry } from "../lsp/registry.ts"
import type { Json } from "../json.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer diagnostics. Everything has a default; tests pass their own. */
export type LspSetup = Pick<LspRegistryOptions, "env" | "settleMs" | "graceMs" | "backoff" | "maxOpenDocuments">

/** The language servers of a session, for a client to show. */
export interface LspState {
  /** Every server that was started for a workspace root, as its registry reports it. */
  readonly servers: readonly LspServerStatus[]
  /** The project's servers that wait for the user's approval and are not started. */
  readonly awaiting: readonly LspServerQuestion[]
}

/** What the user is told, once, about a project's language server that is not started: its whole command, each argument quoted. */
export function skippedLspServerNotice(question: LspServerQuestion): string {
  return `This project's configuration names the language server "${question.name}" (${quotedCommand(question.argv)}). It was not started: a server a project names runs only after you approve it.`
}

/** The grant an approval of a project's language server writes, for `addProjectGrants`. */
export function lspGrant(key: string, now: number): Grant {
  return { scope: "project", rule: { kind: "tool", tool: key }, at: null, grantedAt: now }
}

/**
 * The servers a session's configuration names and which of them may start.
 * `grants` are the project's remembered approvals. Throws `ConfigError` for
 * a server without a command or the languages it serves.
 */
export function planLanguageServers(files: ConfigFiles | null, grants: readonly Grant[], now: number): LspPlan | null {
  const user = files?.user?.lsp
  const project = files?.project?.lsp
  if (user === undefined && project === undefined) return null
  const approved = new Set(grants.flatMap((item) => (item.scope === "project" && item.rule.kind === "tool" && now - item.grantedAt < PROJECT_GRANT_TTL_MS ? [item.rule.tool] : [])))
  return planLspServers(user, project, (key) => approved.has(key))
}

/** Whether a plan can ever add a note: the feature is on, it may wait, and a server is enabled. */
export function offersDiagnostics(plan: LspPlan | null): plan is LspPlan {
  return plan !== null && plan.config.enabled && plan.config.waitMs > 0 && plan.servers.some((server) => server.config.enabled)
}

/** Whether an enabled server of the plan serves the file: it lies inside the working directory and matches a pattern of one. */
export function servesFile(plan: LspPlan, cwd: string, absolute: string): boolean {
  const rel = relative(resolve(cwd), absolute)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false
  const path = sep === "/" ? rel : rel.split(sep).join("/")
  return plan.servers.some((server) => server.config.enabled && server.config.languages.some((language) => language.patterns.some((pattern) => new Bun.Glob(pattern).match(path))))
}

/**
 * A file's text as a language server is given it, or why it is not:
 * `missing` (there is no such file), or `unreadable` (a directory, a file
 * over the module's size bound, one that cannot be read).
 */
export function readDocument(absolute: string): { readonly text: string } | "missing" | "unreadable" {
  try {
    const info = statSync(absolute, { throwIfNoEntry: false })
    if (info === undefined) return "missing"
    // A character is at least a byte: a file larger than the bound in bytes may still fit, and the registry checks the text.
    if (!info.isFile() || info.size > MAX_DOCUMENT_CHARS * 4) return "unreadable"
    return { text: readFileSync(absolute, "utf8") }
  } catch {
    return "unreadable"
  }
}

/**
 * What `tool.settled` records of a diagnosis: `null` when no server serves
 * the file (nothing was asked). `untrusted`: whether the project's
 * configuration file is content the user marked untrusted; the record then
 * says so when the note holds a project server's messages.
 */
export function diagnosticsOf(result: DiagnoseResult, plan: LspPlan, untrusted: boolean): DiagnosticsRecord | null {
  if (result.servers.length === 0) return null
  const servers = result.servers.map((report) => {
    const server = plan.servers.find((item) => item.config.name === report.server)
    return {
      name: report.server,
      origin: server?.origin ?? ("project" as const),
      fingerprint: server?.fingerprint ?? "unknown",
      outcome: report.outcome,
      new: report.comparison?.added.length ?? 0,
      preExisting: report.comparison?.preExisting ?? 0,
      fixed: report.comparison?.fixed ?? 0,
    }
  })
  const noteAdded = result.note !== null
  return {
    noteAdded,
    listed: result.listed,
    omitted: result.omitted,
    waitedMs: Math.max(0, Math.round(result.waitedMs)),
    servers,
    ...(noteAdded && untrusted && servers.some((server) => server.origin === "project" && server.new > 0) ? { untrusted: true as const } : {}),
  }
}

interface Held {
  readonly key: string
  readonly registry: LspRegistry
  /** The sessions that hold it, each with where its notices go. */
  readonly listeners: Set<(notice: LspNotice) => void>
}

/** What a session holds of the hub: the registry of its working directory and configuration, and how to let go of it. */
export interface HeldRegistry {
  readonly key: string
  readonly registry: LspRegistry
  readonly release: () => void
}

/**
 * The engine's registries: one per working directory and configuration,
 * counted by the sessions that use it. `acquire` creates a registry the
 * first time one is asked for (no server starts until a file it serves is
 * read or edited); the last release stops it.
 */
export class LspHub {
  private readonly held = new Map<string, Held>()
  private stopping: Promise<void> | null = null

  constructor(private readonly setup: LspSetup) {}

  /**
   * The registry for a session working in `cwd` under `plan`. The servers
   * the plan says are approved may start in it, also when the registry was
   * created before that approval was given. `onNotice` hears why an edit got
   * no diagnostics, once per server and reason.
   */
  acquire(plan: LspPlan, cwd: string, onNotice: (notice: LspNotice) => void): HeldRegistry | null {
    if (this.stopping !== null) return null
    // Who approved what is not part of what a registry is: an approval given later is told to the one that exists.
    const key = stableJson({ cwd: resolve(cwd), config: plan.config as unknown as Json, servers: plan.servers.map((server) => ({ name: server.config.name, origin: server.origin, fingerprint: server.fingerprint })) })
    let held = this.held.get(key)
    if (held === undefined) {
      const listeners = new Set<(notice: LspNotice) => void>()
      const registry = createLspRegistry({ ...this.setup, plan, cwd, onNotice: (notice) => [...listeners].forEach((listener) => listener(notice)) })
      held = { key, registry, listeners }
      this.held.set(key, held)
    }
    const entry = held
    for (const server of plan.servers) if (server.origin === "project" && server.approved) entry.registry.approve(lspApprovalKey(server))
    entry.listeners.add(onNotice)
    let released = false
    return {
      key,
      registry: entry.registry,
      release: () => {
        if (released) return
        released = true
        entry.listeners.delete(onNotice)
        if (entry.listeners.size > 0 || this.held.get(key) !== entry) return
        this.held.delete(key)
        void entry.registry.stop().catch(() => {})
      },
    }
  }

  /** Stops every server and its process group. The hub creates no registry afterwards. */
  stop(): Promise<void> {
    this.stopping ??= Promise.all([...this.held.values()].map((held) => held.registry.stop().catch(() => {}))).then(() => {
      this.held.clear()
    })
    return this.stopping
  }
}
