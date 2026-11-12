/**
 * Test harness: the ACP server on the real harness assembly (`createHarness`:
 * real step loop, a real SQLite store per session, real tools) with a
 * scripted model, connected to the SDK's own
 * client over in-memory streams. Every message the agent writes is recorded
 * and checked against the SDK's generated schemas for its method.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type Stream,
  client,
  methods,
} from "@agentclientprotocol/sdk"
import { type AnyTool, type EngineOptions, type Harness as CoreHarness, type ModelEntry, type SignInState, createHarness } from "@windlass/core"
import { FakeProvider, type ScriptedResponse } from "@windlass/core/testing"
import * as schemas from "../node_modules/@agentclientprotocol/sdk/dist/v1/schema/zod.gen.js"
import { silentLogger } from "../src/log.ts"
import { type Served, serve } from "../src/server.ts"

export const DEFAULTS = { model: "test-model", effort: null } as const

export const MODELS: readonly ModelEntry[] = [
  { id: "test-model", name: "Test Model", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200_000 },
  { id: "other-model", name: "Other Model", efforts: [], defaultEffort: null, contextWindow: null },
]

type Message = Record<string, unknown>

export interface HarnessOptions {
  readonly responses?: readonly ScriptedResponse[]
  readonly provider?: FakeProvider
  readonly signIn?: () => Promise<SignInState>
  readonly tools?: readonly AnyTool[]
  readonly engine?: Partial<Omit<EngineOptions, "store" | "provider" | "tools" | "dataDir">>
  /** Client capabilities sent in `initialize`. */
  readonly clientCapabilities?: Record<string, unknown>
  /** Reuse the data directory of an earlier harness (a restart). */
  readonly dataDir?: string
  /** Answers `session/request_permission`; cancelled when left out. Every request is recorded in `permissions`. */
  readonly onPermission?: (request: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse>
}

export interface Harness {
  readonly dataDir: string
  readonly workspace: string
  readonly provider: FakeProvider
  /** The harness the server runs on: the one the command line builds, with a scripted model. */
  readonly backend: CoreHarness
  readonly served: Served
  readonly connection: ClientConnection
  /** Every `session/update` the client received, in order. */
  readonly updates: SessionNotification[]
  /** Every extension notification the client received, in order. */
  readonly ext: { method: string; params: Message }[]
  /** Every `session/request_permission` the agent sent, in order. */
  readonly permissions: RequestPermissionRequest[]
  /** Every message the agent wrote, in order. */
  readonly wire: Message[]
  /** Schema violations found in the agent's messages. */
  readonly violations: string[]
  initialize(): Promise<unknown>
  newSession(): Promise<string>
  /** Updates of one session, by kind. */
  of(sessionId: string, kind?: SessionUpdate["sessionUpdate"]): SessionUpdate[]
  /** Closes the client side and the agent's input, as a client process that exits closes the agent's stdin. */
  disconnect(): Promise<void>
  /** Disconnects, closes the backend and removes the directories (unless `keep`). */
  close(options?: { keep?: boolean }): Promise<void>
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.dataDir === undefined ? realpathSync(mkdtempSync(join(tmpdir(), "wl-acp-"))) : null
  const dataDir = options.dataDir ?? join(root!, "data")
  const workspace = options.dataDir === undefined ? join(root!, "work") : join(dataDir, "..", "work")
  await Bun.write(join(workspace, ".keep"), "")
  const provider = options.provider ?? new FakeProvider(options.responses ?? [])
  const backend = createHarness({
    defaultModel: DEFAULTS.model,
    defaultEffort: DEFAULTS.effort,
    log: () => {},
    dataDir,
    provider,
    models: async () => MODELS,
    ...(options.signIn === undefined ? {} : { signIn: options.signIn }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    // No configuration files of the machine the tests run on.
    engine: { discover: () => [], loadConfig: null, ...options.engine },
  })

  const wire: Message[] = []
  const violations: string[] = []
  const requests = new Map<unknown, string>()
  const toClient = new TransformStream<Message, Message>({
    transform(message, controller) {
      wire.push(structuredClone(message))
      const problem = validate(message, requests)
      if (problem !== null) violations.push(problem)
      controller.enqueue(message)
    },
  })
  let agentInput: TransformStreamDefaultController<Message> | null = null
  const toAgent = new TransformStream<Message, Message>({
    start(controller) {
      agentInput = controller
    },
    transform(message, controller) {
      if (typeof message.method === "string" && "id" in message) requests.set(message.id, message.method)
      controller.enqueue(message)
    },
  })
  const agentStream = { writable: toClient.writable, readable: toAgent.readable } as unknown as Stream
  const clientStream = { writable: toAgent.writable, readable: toClient.readable } as unknown as Stream
  const served = serve(backend, agentStream, { log: silentLogger })

  const updates: SessionNotification[] = []
  const ext: { method: string; params: Message }[] = []
  const permissions: RequestPermissionRequest[] = []
  const connection = client({ name: "test-client" })
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params)
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      permissions.push(params)
      return options.onPermission === undefined ? { outcome: { outcome: "cancelled" } } : options.onPermission(params)
    })
    .onNotification("*", ({ method, params }) => {
      ext.push({ method, params: params as Message })
    })
    .connect(clientStream)

  const harness: Harness = {
    dataDir,
    workspace,
    provider,
    backend,
    served,
    connection,
    updates,
    ext,
    permissions,
    wire,
    violations,
    initialize: () =>
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: 1,
        clientCapabilities: (options.clientCapabilities ?? {}) as never,
        clientInfo: { name: "test-client", version: "1.0.0" },
      }),
    newSession: async () => (await connection.agent.request(methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId,
    of: (sessionId, kind) =>
      updates.filter((note) => note.sessionId === sessionId && (kind === undefined || note.update.sessionUpdate === kind)).map((note) => note.update),
    disconnect: async () => {
      connection.close()
      try {
        agentInput?.terminate()
      } catch {}
      await served.done
    },
    close: async ({ keep = false } = {}) => {
      await harness.disconnect()
      await backend.close()
      if (!keep && root !== null) rmSync(root, { recursive: true, force: true })
    },
  }
  return harness
}

/** Waits until `check` holds, polling; fails after `ms`. */
export async function until(check: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const RESPONSES: Record<string, { parse: (value: unknown) => unknown }> = {
  initialize: schemas.zInitializeResponse,
  authenticate: schemas.zAuthenticateResponse,
  "session/new": schemas.zNewSessionResponse,
  "session/load": schemas.zLoadSessionResponse,
  "session/resume": schemas.zResumeSessionResponse,
  "session/list": schemas.zListSessionsResponse,
  "session/close": schemas.zCloseSessionResponse,
  "session/delete": schemas.zDeleteSessionResponse,
  "session/set_config_option": schemas.zSetSessionConfigOptionResponse,
  "session/prompt": schemas.zPromptResponse,
}

/** Checks one agent message against the SDK's schema for it. Extension messages only need the JSON-RPC shape. */
function validate(message: Message, requests: Map<unknown, string>): string | null {
  try {
    if (message.jsonrpc !== "2.0") return `not JSON-RPC 2.0: ${JSON.stringify(message)}`
    if (typeof message.method === "string") {
      if (message.method === "session/update") schemas.zSessionNotification.parse(message.params)
      else if (message.method === "session/request_permission") schemas.zRequestPermissionRequest.parse(message.params)
      else if (!message.method.startsWith("_")) return `unexpected method from the agent: ${message.method}`
      else if (typeof message.params !== "object" || message.params === null) return `${message.method} without params object`
      return null
    }
    const method = requests.get(message.id)
    if (method === undefined) return `response to an unknown request ${String(message.id)}`
    if ("error" in message) {
      schemas.zError.parse(message.error)
      return null
    }
    const schema = RESPONSES[method]
    if (schema !== undefined) schema.parse(message.result)
    else if (!method.startsWith("_")) return `no schema for ${method}`
    return null
  } catch (error) {
    return `${String(message.method ?? requests.get(message.id))}: ${error instanceof Error ? error.message : String(error)} in ${JSON.stringify(message).slice(0, 400)}`
  }
}
