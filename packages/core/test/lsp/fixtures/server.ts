/**
 * A scripted language server, for the tests and the demo. Run with
 * `bun server.ts [flags]`. Its diagnostics come from markers in the text:
 *
 *   ERROR(name)   an error "cannot find name 'name'" (code E1) on the marker
 *   WARN(name)    a warning "'name' is declared but never used" (code W1)
 *
 * Flags:
 *   --pull                    offer only the pull model (`textDocument/diagnostic`), never publish
 *   --delay <ms>              wait this long before each publication or pull answer (a slow server)
 *   --silent                  read everything, answer nothing (a server that never answers)
 *   --stale                   on a change, first publish the previous version's diagnostics with
 *                             the previous version number, then the fresh ones after --stale-delay
 *   --stale-delay <ms>        default 150
 *   --crash-on-change <n>     exit with code 3 on the n-th didChange
 *   --flood <n>               every ERROR marker gives n errors (with distinct messages)
 *   --no-version              publish without a version number
 *   --ask                     during initialize, send the client the requests a real server sends and log the answers
 *   --log <file>              append each method received, and the answers to --ask, one per line
 *   --pid-file <file>         write this process's pid
 *   --grandchild <file>       start a long-running child and write its pid
 *   --stubborn                ignore stdin's end, SIGTERM and exit (needs SIGKILL)
 *
 * The framing is written here by hand, independently of the module's codec.
 */
import { appendFileSync, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const flags = new Map<string, string>()
for (let i = 0; i < argv.length; i += 1) {
  const key = argv[i]!.replace(/^--/, "")
  const value = argv[i + 1]
  if (value !== undefined && !value.startsWith("--")) {
    flags.set(key, value)
    i += 1
  } else flags.set(key, "")
}
const num = (key: string, fallback: number) => (flags.has(key) ? Number(flags.get(key)) : fallback)
const pull = flags.has("pull")
const delay = num("delay", 0)
const silent = flags.has("silent")
const stale = flags.has("stale")
const staleDelay = num("stale-delay", 150)
const crashOnChange = num("crash-on-change", 0)
const flood = num("flood", 1)
const versioned = !flags.has("no-version")
const stubborn = flags.has("stubborn")
const logFile = flags.get("log")
const log = (line: string) => {
  if (logFile !== undefined) appendFileSync(logFile, `${line}\n`)
}

if (flags.has("pid-file")) writeFileSync(flags.get("pid-file")!, String(process.pid))
if (flags.has("grandchild")) {
  const child = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  writeFileSync(flags.get("grandchild")!, String(child.pid))
}
if (stubborn) {
  process.on("SIGTERM", () => {})
  setInterval(() => {}, 1 << 30)
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const send = (message: { [key: string]: Json }) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8")
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]))
}

function diagnosticsOf(text: string): Json[] {
  const out: Json[] = []
  text.split("\n").forEach((line, number) => {
    for (const match of line.matchAll(/\b(ERROR|WARN)\(([^)]*)\)/g)) {
      const range = { start: { line: number, character: match.index! }, end: { line: number, character: match.index! + match[0].length } }
      if (match[1] === "ERROR")
        for (let i = 0; i < flood; i += 1)
          out.push({ range, severity: 1, code: "E1", source: "fixture", message: flood === 1 ? `cannot find name '${match[2]}'` : `cannot find name '${match[2]}' (${i + 1})` })
      else out.push({ range, severity: 2, code: "W1", source: "fixture", message: `'${match[2]}' is declared but never used` })
    }
  })
  return out
}

const documents = new Map<string, { version: number; text: string; previous: Json[] }>()
let changes = 0
let nextId = 1000
const asked = new Map<number, string>()

const publish = (uri: string, version: number, diagnostics: Json[]) =>
  send({ method: "textDocument/publishDiagnostics", params: { uri, ...(versioned ? { version } : {}), diagnostics } })

const later = (ms: number, fn: () => void) => (ms > 0 ? setTimeout(fn, ms) : fn())

function handle(message: { [key: string]: Json }) {
  const method = typeof message.method === "string" ? message.method : null
  if (method === null) {
    // An answer to one of our --ask requests.
    const what = asked.get(message.id as number)
    if (what !== undefined) log(`answer ${what} ${JSON.stringify(message.result ?? message.error ?? null)}`)
    return
  }
  log(method)
  if (silent) return
  const params = (message.params ?? {}) as { [key: string]: Json }
  const id = message.id
  switch (method) {
    case "initialize": {
      if (flags.has("ask")) {
        const ask = (m: string, p: Json) => {
          const requestId = nextId++
          asked.set(requestId, m)
          send({ id: requestId, method: m, params: p })
        }
        ask("workspace/configuration", { items: [{ section: "fixture.rules" }, { section: "missing" }] })
        ask("client/registerCapability", { registrations: [{ id: "r1", method: "workspace/didChangeWatchedFiles", registerOptions: {} }] })
        ask("window/workDoneProgress/create", { token: "t1" })
        ask("workspace/unknownThing", {})
      }
      const capabilities: { [key: string]: Json } = { textDocumentSync: { openClose: true, change: 1, save: { includeText: false } } }
      if (pull) capabilities.diagnosticProvider = { interFileDependencies: false, workspaceDiagnostics: false }
      send({ id: id!, result: { capabilities, serverInfo: { name: "fixture-lsp", version: "1" } } })
      return
    }
    case "shutdown":
      send({ id: id!, result: null })
      return
    case "exit":
      if (!stubborn) process.exit(0)
      return
    case "textDocument/didOpen": {
      const doc = params.textDocument as { uri: string; version: number; text: string }
      documents.set(doc.uri, { version: doc.version, text: doc.text, previous: diagnosticsOf(doc.text) })
      if (!pull) later(delay, () => publish(doc.uri, doc.version, diagnosticsOf(doc.text)))
      return
    }
    case "textDocument/didChange": {
      changes += 1
      if (crashOnChange > 0 && changes === crashOnChange) {
        process.stderr.write("fixture: crashing on purpose\n")
        process.exit(3)
      }
      const doc = params.textDocument as { uri: string; version: number }
      const text = ((params.contentChanges as Json[])[0] as { text: string }).text
      const entry = documents.get(doc.uri)
      if (entry === undefined) return
      const previous = diagnosticsOf(entry.text)
      const previousVersion = entry.version
      entry.version = doc.version
      entry.text = text
      if (pull) return
      if (stale) {
        publish(doc.uri, previousVersion, previous)
        later(staleDelay, () => publish(doc.uri, doc.version, diagnosticsOf(text)))
        return
      }
      later(delay, () => {
        // A slow server publishes what is current when it gets round to it.
        const now = documents.get(doc.uri)
        if (now !== undefined && now.version === doc.version) publish(doc.uri, doc.version, diagnosticsOf(text))
      })
      return
    }
    case "textDocument/diagnostic": {
      const uri = (params.textDocument as { uri: string }).uri
      later(delay, () => {
        const entry = documents.get(uri)
        send({ id: id!, result: { kind: "full", resultId: `r${entry?.version ?? 0}`, items: entry === undefined ? [] : diagnosticsOf(entry.text) } })
      })
      return
    }
    case "textDocument/didClose":
      documents.delete((params.textDocument as { uri: string }).uri)
      return
    default:
      if (id !== undefined && id !== null) send({ id, error: { code: -32601, message: `unknown ${method}` } })
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end === -1) return
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))
    if (match === null) process.exit(4)
    const length = Number(match[1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8")
    buffer = buffer.subarray(end + 4 + length)
    handle(JSON.parse(body))
  }
})
process.stdin.on("end", () => {
  log("stdin closed")
  if (!stubborn) process.exit(0)
})
