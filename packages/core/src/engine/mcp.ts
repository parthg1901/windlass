/**
 * MCP servers, as the step loop offers them (`mcp/` has the module).
 *
 * - `mcp_search` and `mcp_call` are in a session's frozen tool list from its
 *   first baseline, whether or not a server is configured. Their specs are
 *   constants, so a server added, started late or changed never touches the
 *   list. No tool of a server is ever in it.
 * - What exists reaches the model as the catalogue: an appended message
 *   under source `mcp`, at a step boundary, when a server first offers tools,
 *   when the published view changes, and as a withdrawal when none is left.
 * - `mcp_call` has origin `mcp` and effect `network`: the approval layer
 *   decides it, asks about it by the server's tool (`github/create_issue`,
 *   not `mcp_call`), and a result that holds a server's content taints the
 *   session (`approval/taint.ts`).
 *
 * **Who may start a server.** A server named by the user's own configuration
 * file is started. A server the project's file names, or changes in any way,
 * is not: opening a repository must not run a command, or send the user's
 * environment to an address, that the repository chose. Such a server waits
 * until the user approved it, and the approval is a remembered approval for
 * the project like any other (`approval/grants.ts`: a `tool` rule, kept
 * under the data directory for 30 days, keyed by the workspace's real path),
 * for exactly this definition of the server: the rule names the server and
 * the fingerprint of its merged configuration, so an edited command is a new
 * question. Nobody present, nothing starts: there is no unattended default.
 *
 * **Lifetime.** The engine has one hub. It holds one registry per distinct
 * server (its configuration and, for a started one, the directory it starts
 * in), shared by every session whose configuration names that server, started
 * when the first of them needs it and stopped when the last lets go, or when
 * the engine closes. Starting never waits: a session's first step waits a
 * bounded moment (`startWaitMs`) for servers that have never yet answered, so
 * that a one-prompt run sees the catalogue, and nothing else ever waits.
 */
import { resolve } from "node:path"
import { type Grant, type GrantRule, PROJECT_GRANT_TTL_MS } from "../approval/grants.ts"
import { mergeConfigFiles } from "../config/schema.ts"
import type { InstructionDetail } from "../event/durable.ts"
import { fingerprint } from "../instructions/source.ts"
import type { AppendedSource } from "../instructions/state.ts"
import { type CallInput, type McpBridgeBackend, type SearchInput, mcpCallTool, mcpSearchTool } from "../mcp/bridge.ts"
import { type CatalogueServer, MCP_CATALOGUE_KEY, catalogueSource, catalogueUpdate, stableJson } from "../mcp/catalogue.ts"
import { type McpConfigSection, type McpServerConfig, resolveMcpConfig } from "../mcp/config.ts"
import { type McpCallOutcome, type McpRegistry, type McpRegistryOptions, type ServerStatus, createMcpRegistry } from "../mcp/registry.ts"
import type { Json } from "../json.ts"
import type { Tool, ToolContext } from "../tool/tool.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer MCP servers. Everything has a default; tests pass their own. */
export interface McpSetup extends Pick<McpRegistryOptions, "env" | "backoff" | "dropAfterMs" | "probeMs" | "graceMs" | "random"> {
  /**
   * How long the first step of an execution waits for servers that have
   * neither connected nor failed yet, so that the catalogue is in the first
   * request of a one-prompt run. Default 1500 ms; `0` never waits.
   */
  readonly startWaitMs?: number
}

export const MCP_START_WAIT_MS = 1500

/** One server of a session's configuration, and whether it may be started. */
export interface McpServerPlan {
  readonly config: McpServerConfig
  /** `user`: the user's own file defines it and the project's leaves it alone. `project`: the project's file names or changes it. */
  readonly origin: "user" | "project"
  /** Identifies this definition of the server: what an approval of it is remembered for. */
  readonly fingerprint: string
  /** Whether it may be started: always for a user's server; for a project's, once the user approved this definition. */
  readonly approved: boolean
}

/** What a client shows for a server that waits for the user's approval. */
export interface McpServerQuestion {
  readonly name: string
  readonly fingerprint: string
  /** The command with its arguments, or the address: what approving it runs or reaches. */
  readonly subject: string
  /** Facts the user needs to answer, one per line. */
  readonly details: readonly string[]
}

/** The MCP servers of a session, for a client to show. */
export interface McpState {
  /** Every started server, as its registry reports it. */
  readonly servers: readonly ServerStatus[]
  /** The project's servers that wait for the user's approval and are not started. */
  readonly awaiting: readonly McpServerQuestion[]
}

/** The rule a remembered approval of a project's server is stored as. */
export function serverGrantRule(plan: Pick<McpServerPlan, "config" | "fingerprint">): GrantRule {
  return { kind: "tool", tool: `mcp-server:${plan.config.name}:${plan.fingerprint}` }
}

/** The grant an approval of a project's server writes, for `addProjectGrants`. */
export function serverGrant(plan: Pick<McpServerPlan, "config" | "fingerprint">, now: number): Grant {
  return { scope: "project", rule: serverGrantRule(plan), at: null, grantedAt: now }
}

/**
 * The servers a session's configuration names and which of them may start.
 * `grants` are the project's remembered approvals. Throws `ConfigError` for a
 * server that is neither started nor reached.
 */
export function planServers(files: ConfigFiles | null, grants: readonly Grant[], now: number): McpServerPlan[] {
  const user = files?.user?.mcp
  const project = files?.project?.mcp
  if (user === undefined && project === undefined) return []
  // What the user's own file gives, without the project's. A server only the project completes does not resolve here.
  const own = new Map(Object.keys(user?.servers ?? {}).flatMap((name) => {
    try {
      const config = resolveMcpConfig({ servers: { [name]: user!.servers![name]! } }).servers[0]!
      return [[name, stableJson(config as unknown as Json)] as const]
    } catch {
      return []
    }
  }))
  return resolveMcpConfig(mergeSections(user, project)).servers.map((config) => {
    const text = stableJson(config as unknown as Json)
    const print = fingerprint(text).slice(0, 16)
    const origin = own.get(config.name) === text ? "user" : "project"
    const rule = serverGrantRule({ config, fingerprint: print })
    const approved =
      origin === "user" || grants.some((item) => item.scope === "project" && item.rule.kind === "tool" && item.rule.tool === (rule as { tool: string }).tool && now - item.grantedAt < PROJECT_GRANT_TTL_MS)
    return { config, origin, fingerprint: print, approved }
  })
}

/** The project's section over the user's, key by key, exactly as the configuration merge does it. */
function mergeSections(user: McpConfigSection | undefined, project: McpConfigSection | undefined): McpConfigSection | undefined {
  return mergeConfigFiles(user === undefined ? null : { mcp: user }, project === undefined ? null : { mcp: project }).mcp
}

/** The question about a project's server, in the words a client shows. */
export function serverQuestion(plan: McpServerPlan): McpServerQuestion {
  const transport = plan.config.transport
  const subject = transport.kind === "stdio" ? [transport.command, ...transport.args].join(" ") : transport.url
  const named = Object.keys(transport.kind === "stdio" ? transport.env : transport.headers)
  return {
    name: plan.config.name,
    fingerprint: plan.fingerprint,
    subject,
    details: [
      transport.kind === "stdio"
        ? `This project's configuration names the MCP server "${plan.config.name}", which is started by running that command${transport.cwd === null ? "" : ` in ${transport.cwd}`}. It runs outside the sandbox, with your permissions.`
        : `This project's configuration names the MCP server "${plan.config.name}", which is reached at that address. What the model sends it leaves this machine.`,
      ...(named.length === 0 ? [] : [`It is given ${transport.kind === "stdio" ? "these variables" : "these headers"}, with values from your environment where they name one: ${named.join(", ")}.`]),
      "Approving it is remembered for this project for 30 days, for exactly this definition of the server.",
    ],
  }
}

/** What a session's bridge tools and its catalogue read: its servers, each in a registry of its own. */
export interface SessionServers extends McpBridgeBackend {
  /** Resolves once every server has connected or failed at least once, or after `timeoutMs`. */
  readonly settled: (timeoutMs: number) => Promise<void>
  /** Whether a server has neither connected nor failed yet. */
  readonly starting: () => boolean
}

interface Held {
  readonly key: string
  readonly registry: McpRegistry
  sessions: number
}

/**
 * The engine's registries: one per distinct server, counted by the sessions
 * that use it. `acquire` starts a server the first time one is asked for;
 * `release` stops it when nobody uses it any more.
 */
export class McpHub {
  private readonly held = new Map<string, Held>()
  private stopping: Promise<void> | null = null

  constructor(
    private readonly setup: McpSetup,
    private readonly diagnose: (server: string, message: string) => void,
  ) {}

  get startWaitMs(): number {
    return this.setup.startWaitMs ?? MCP_START_WAIT_MS
  }

  /** The registry of `config` for a session working in `cwd`, started if it was not. Returns its key, to release it by. */
  acquire(config: McpServerConfig, cwd: string): { readonly key: string; readonly registry: McpRegistry } | null {
    if (this.stopping !== null) return null
    // A started server runs in a directory, so two directories are two servers; a reached one is the same from anywhere.
    const key = stableJson({ config: config as unknown as Json, cwd: config.transport.kind === "stdio" ? resolve(cwd) : null })
    let held = this.held.get(key)
    if (held === undefined) {
      const { startWaitMs: _wait, ...options } = this.setup
      const registry = createMcpRegistry({ ...options, servers: [config], cwd, onDiagnostic: this.diagnose })
      held = { key, registry, sessions: 0 }
      this.held.set(key, held)
      registry.start()
    }
    held.sessions += 1
    return { key, registry: held.registry }
  }

  release(key: string): void {
    const held = this.held.get(key)
    if (held === undefined) return
    held.sessions -= 1
    if (held.sessions > 0) return
    this.held.delete(key)
    void held.registry.stop().catch(() => {})
  }

  /** Stops every server. The hub starts none afterwards. */
  stop(): Promise<void> {
    this.stopping ??= Promise.all([...this.held.values()].map((held) => held.registry.stop().catch(() => {}))).then(() => {
      this.held.clear()
    })
    return this.stopping
  }
}

/** The servers of one session as one backend: calls are routed by server name. */
export function sessionServers(registries: ReadonlyMap<string, McpRegistry>, awaiting: readonly McpServerPlan[]): SessionServers {
  const all = () => [...registries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, registry]) => registry)
  return {
    servers: () => all().flatMap((registry) => registry.servers()),
    status: () => all().flatMap((registry) => registry.status()),
    call: async (request): Promise<McpCallOutcome> => {
      const registry = registries.get(request.server)
      if (registry !== undefined) return registry.call(request)
      if (awaiting.some((plan) => plan.config.name === request.server))
        return {
          kind: "refused",
          message: `The MCP server ${JSON.stringify(request.server)} is named by this project's configuration and was not started: it waits for the user's approval. Tell the user; do not try another way to reach it.`,
        }
      const known = [...registries.keys()].sort()
      return { kind: "refused", message: `There is no MCP server named ${JSON.stringify(request.server)}. Servers: ${known.join(", ") || "none"}.` }
    },
    settled: (timeoutMs) => Promise.all(all().map((registry) => registry.settled(timeoutMs))).then(() => {}),
    starting: () => all().some((registry) => registry.status().some((status) => status.state === "idle" || status.state === "connecting")),
  }
}

/**
 * The bridge tools of an engine. One pair for every session: the specs are
 * the module's constants, and each call reads the calling session's servers.
 * `mcp_call` is marked as coming from MCP, and names the server's tool as
 * what an approval is asked about and remembered for.
 */
export function engineMcpTools(serversOf: (context: ToolContext) => McpBridgeBackend | null): { readonly search: Tool<SearchInput>; readonly call: Tool<CallInput> } {
  const search = mcpSearchTool(() => null)
  const call = mcpCallTool(() => null)
  return {
    search: { ...search, execute: (input, context) => mcpSearchTool(() => serversOf(context)).execute(input, context) },
    call: {
      ...call,
      origin: "mcp",
      subject: (input: CallInput) => {
        const tool = typeof input.tool === "string" && typeof input.server === "string" && input.tool.startsWith(`${input.server}/`) ? input.tool.slice(input.server.length + 1) : input.tool
        return `${String(input.server)}/${String(tool)}`
      },
      execute: (input, context) => mcpCallTool(() => serversOf(context)).execute(input, context),
    },
  }
}

/** The catalogue as a source the loop appends when it changed. */
export function catalogueAppended(servers: readonly CatalogueServer[]): AppendedSource {
  const source = catalogueSource(servers)
  return {
    key: MCP_CATALOGUE_KEY,
    update: (known) => {
      const update = catalogueUpdate(known, source)
      if (update === null) return null
      // The names and descriptions in the text were written by these servers: recorded beside it, never read back out of it.
      const detail: InstructionDetail = {
        kind: "mcp",
        servers: servers.filter((server) => server.tools.length > 0).map((server) => ({ name: server.name, tools: server.tools.length, untrusted: server.untrusted })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      }
      return { ...update, detail }
    },
  }
}
