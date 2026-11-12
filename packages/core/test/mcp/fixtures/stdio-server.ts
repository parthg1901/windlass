/**
 * A scripted MCP server over stdio, for tests and the demo. Run with
 * `bun stdio-server.ts [flags]`:
 *
 *   --era modern|legacy|dual|legacy-silent   protocol era (default modern); legacy-silent ignores
 *                                            every request before initialize, as some old servers do
 *   --name <name>                            serverInfo name
 *   --startup-delay <ms>                     read nothing for this long after starting
 *   --crash-on-start                         print to stderr and exit 1 at once
 *   --garbage                                print lines that are not JSON-RPC to stdout
 *   --only-garbage                           print only garbage, never answer
 *   --grandchild <file>                      start a long-running child and write its pid to <file>
 *   --stubborn                               ignore stdin EOF and SIGTERM (needs SIGKILL)
 *   --pid-file <file>                        write this process's pid to <file>
 *   plus the tool options of behaviour.ts (--filler, --page-size, --shuffle, --bad-tools, --only, --tag, --log)
 */
import { writeFileSync } from "node:fs"
import { UnknownTool, createBehaviour, parseFlags, readOptions } from "./behaviour.ts"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type Obj = { [key: string]: JsonValue }

const flags = parseFlags(process.argv.slice(2))
const era = flags.get("era") ?? "modern"
const name = flags.get("name") ?? "fixture"
const MODERN = "2026-07-28"
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"]

if (flags.has("pid-file")) writeFileSync(flags.get("pid-file")!, String(process.pid))
if (flags.has("crash-on-start")) {
  process.stderr.write("fatal: the fixture was told to fail at start-up\n")
  process.exit(1)
}
if (flags.has("grandchild")) {
  const child = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  writeFileSync(flags.get("grandchild")!, String(child.pid))
}
const stubborn = flags.has("stubborn")
if (stubborn) process.on("SIGTERM", () => {})
if (flags.has("startup-delay")) await Bun.sleep(Number(flags.get("startup-delay")))

const send = (message: Obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
if (flags.has("garbage") || flags.has("only-garbage")) process.stdout.write("fixture server starting (this line is not JSON-RPC)\n")

let initialized = false
const subscriptions = new Set<JsonValue>()
const inFlight = new Map<string, AbortController>()
const behaviour = createBehaviour(readOptions(flags), () => {
  if (era === "modern" || era === "dual")
    for (const id of subscriptions) send({ method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": id } } })
  if ((era === "legacy" || era === "legacy-silent" || era === "dual") && initialized) send({ method: "notifications/tools/list_changed" })
})

const modernOk = era === "modern" || era === "dual"
const legacyOk = era !== "modern"

async function handle(message: Obj) {
  const method = message.method
  const id = message.id
  const params = (message.params ?? {}) as Obj
  if (typeof method !== "string") return
  if (id === undefined) {
    if (method === "notifications/initialized") initialized = true
    if (method === "notifications/cancelled") {
      const target = String(params.requestId)
      behaviour.log(`cancelled ${target}`)
      inFlight.get(target)?.abort()
      subscriptions.delete(params.requestId as JsonValue)
    }
    return
  }
  const meta = (params._meta ?? {}) as Obj
  const version = meta["io.modelcontextprotocol/protocolVersion"]
  const isModern = typeof version === "string"
  const reply = (result: Obj) => send({ id, result: isModern ? { resultType: "complete", ...result } : result })
  const fail = (code: number, text: string, data?: JsonValue) => send({ id, error: data === undefined ? { code, message: text } : { code, message: text, data } })

  if (method === "initialize") {
    if (!legacyOk) return fail(-32601, `initialize is not supported; this server speaks ${MODERN}`)
    const requested = String(params.protocolVersion)
    initialized = false
    return reply({
      protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[1]!,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name, version: "1.0.0" },
      instructions: `Legacy fixture ${name}.`,
    })
  }
  if (isModern) {
    if (!modernOk) {
      if (era === "legacy-silent") return
      return fail(-32601, `Method not found: ${method}`)
    }
    if (version !== MODERN) return fail(-32022, "Unsupported protocol version", { supported: [MODERN], requested: version as JsonValue })
  } else if (!initialized) {
    if (era === "legacy-silent") return
    if (!legacyOk) return fail(-32602, "missing io.modelcontextprotocol/protocolVersion in _meta")
    return fail(-32600, "the server is not initialized")
  }

  switch (method) {
    case "server/discover":
      return reply({
        supportedVersions: [MODERN],
        capabilities: { tools: { listChanged: true } },
        _meta: { "io.modelcontextprotocol/serverInfo": { name, version: "1.0.0" } },
        instructions: `Modern fixture ${name}.`,
      })
    case "ping":
      return reply({})
    case "tools/list":
      return reply({ ...behaviour.list(params.cursor), ...(isModern ? { ttlMs: 0, cacheScope: "private" } : {}) })
    case "subscriptions/listen":
      subscriptions.add(id as JsonValue)
      send({ method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": id as JsonValue }, notifications: { toolsListChanged: true } } })
      return
    case "tools/call": {
      const controller = new AbortController()
      inFlight.set(String(id), controller)
      const token = meta.progressToken
      try {
        const result = await behaviour.call(String(params.name), (params.arguments ?? {}) as Obj, {
          signal: controller.signal,
          headers: {},
          progress: (progress, total, text) => {
            if (token !== undefined) send({ method: "notifications/progress", params: { progressToken: token, progress, total, message: text } })
          },
          crash: () => {
            process.stderr.write("fixture: crashing in the middle of a call\n")
            process.exit(3)
          },
        })
        if (!controller.signal.aborted) reply(result)
      } catch (error) {
        if (error instanceof UnknownTool) fail(-32602, `Unknown tool: ${error.message}`)
        else fail(-32603, String(error))
      } finally {
        inFlight.delete(String(id))
      }
      return
    }
    default:
      return fail(-32601, `Method not found: ${method}`)
  }
}

const decoder = new TextDecoder()
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  let index = buffer.indexOf("\n")
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf("\n")
    if (line.trim() === "") continue
    if (flags.has("only-garbage")) {
      process.stdout.write(`not json: ${line.length} bytes received\n`)
      continue
    }
    if (flags.has("garbage")) process.stdout.write("debug: got a message\n")
    let parsed: Obj
    try {
      parsed = JSON.parse(line) as Obj
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } })
      continue
    }
    void handle(parsed)
  }
}
// stdin closed: a well-behaved server exits.
if (stubborn) await new Promise(() => {})
process.exit(0)
