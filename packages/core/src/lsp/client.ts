/**
 * One language server session, for diagnostics and nothing else.
 *
 * Sent: `initialize`, `initialized`, `textDocument/didOpen`, `didChange`
 * (always the full text: a change event without a range replaces the
 * document, which every sync kind accepts), `didSave`, `didClose`, the pull
 * request `textDocument/diagnostic` when the server offers it, `shutdown`,
 * `exit`. Received: `textDocument/publishDiagnostics`. Answered, minimally, so
 * a server keeps going: `workspace/configuration` (from `settings`),
 * `client/registerCapability` and `unregisterCapability`,
 * `window/workDoneProgress/create`, `window/showMessageRequest`,
 * `workspace/workspaceFolders`, `workspace/applyEdit` (refused), the
 * `.../refresh` requests. Anything else is "method not found".
 *
 * Each document keeps its version (incremented on every change) and the last
 * diagnostics published for it with the version they were for. A waiter asks
 * for diagnostics of one version: a publication that names an older version
 * is stale and ignored; one that names no version counts when it arrives
 * after the change was sent.
 */
import { pathToFileURL } from "node:url"
import { type DiagnosticSet, parseDiagnostics } from "./diagnostics.ts"
import { type Connection, LspError } from "./transport.ts"
import { brand } from "../brand.ts"
import type { Json } from "../json.ts"

export interface SessionOptions {
  readonly rootPath: string
  readonly initializationOptions: Json | null
  readonly settings: Json | null
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

export interface Published {
  /** The version the server said it is for, or `null` when it did not say. */
  readonly version: number | null
  /** Counts publications for the document, so "after the change" can be told. */
  readonly seq: number
  readonly set: DiagnosticSet
}

export interface OpenDocument {
  readonly uri: string
  readonly languageId: string
  version: number
  text: string
  /** The seq of the last publication when the current version was sent. */
  sentAtSeq: number
  published: Published | null
  /** The last pull result for the current version, and the id for the next pull. */
  pulled: { readonly version: number; readonly set: DiagnosticSet } | null
  resultId: string | null
}

export interface LspSession {
  readonly connection: Connection
  readonly pull: boolean
  readonly saveOptions: { readonly includeText: boolean } | null
  readonly serverName: string | null
  document(uri: string): OpenDocument | undefined
  open(path: string, languageId: string, text: string): OpenDocument
  change(document: OpenDocument, text: string): void
  save(document: OpenDocument): void
  close(document: OpenDocument): void
  /**
   * Diagnostics for the document's current version: from a pull, or the first
   * fresh publication plus whatever follows it within `settleMs`. `null` at the
   * deadline. Never waits past `deadline` (a `performance.now()` time).
   */
  diagnostics(document: OpenDocument, deadline: number, settleMs: number, signal?: AbortSignal): Promise<DiagnosticSet | null>
  openCount(): number
  /** `shutdown`, `exit`, then the connection's close. Bounded by `graceMs` for the answer. */
  shutdown(graceMs: number): Promise<void>
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
    publishDiagnostics: { versionSupport: true, relatedInformation: false, codeDescriptionSupport: false, dataSupport: false },
    diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
  },
  workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: { dynamicRegistration: false } },
  window: { workDoneProgress: true },
}

/** Starts the session on an open connection. Rejects with `LspError` when `initialize` fails or times out. */
export async function startSession(connection: Connection, options: SessionOptions): Promise<LspSession> {
  const documents = new Map<string, OpenDocument>()
  const waiters = new Set<() => void>()
  let seq = 0
  let pull = false
  const rootUri = pathToFileURL(options.rootPath).href

  connection.onNotification((method, params) => {
    if (method !== "textDocument/publishDiagnostics" || !isObject(params) || typeof params.uri !== "string") return
    const document = documents.get(params.uri)
    if (document === undefined) return
    seq += 1
    const version = typeof params.version === "number" && Number.isSafeInteger(params.version) ? params.version : null
    document.published = { version, seq, set: parseDiagnostics(params.diagnostics) }
    for (const wake of [...waiters]) wake()
  })

  void connection.closed.then(() => {
    for (const wake of [...waiters]) wake()
  })

  connection.onRequest((method, params) => {
    switch (method) {
      case "workspace/configuration": {
        const items = isObject(params) && Array.isArray(params.items) ? params.items : []
        return { result: items.map((item: unknown) => lookup(options.settings, isObject(item) && typeof item.section === "string" ? item.section : null)) }
      }
      case "client/registerCapability": {
        const registrations = isObject(params) && Array.isArray(params.registrations) ? params.registrations : []
        if (registrations.some((r: unknown) => isObject(r) && r.method === "textDocument/diagnostic")) pull = true
        return { result: null }
      }
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
      case "window/showDocument":
      case "workspace/diagnostic/refresh":
      case "workspace/semanticTokens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/inlineValue/refresh":
      case "workspace/codeLens/refresh":
        return { result: null }
      case "workspace/workspaceFolders":
        return { result: [{ uri: rootUri, name: basename(options.rootPath) }] }
      case "workspace/applyEdit":
        return { result: { applied: false, failureReason: "this client does not apply edits" } }
      default:
        return { error: { code: -32601, message: `method not found: ${method}` } }
    }
  })

  const initialized = await connection.request(
    "initialize",
    {
      processId: process.pid,
      clientInfo: { name: brand.name },
      rootPath: options.rootPath,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(options.rootPath) }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: options.initializationOptions ?? undefined,
    },
    { timeoutMs: options.timeoutMs, signal: options.signal },
  )
  const capabilities = isObject(initialized) && isObject(initialized.capabilities) ? initialized.capabilities : {}
  const serverInfo = isObject(initialized) && isObject(initialized.serverInfo) && typeof initialized.serverInfo.name === "string" ? initialized.serverInfo.name : null
  if (capabilities.diagnosticProvider !== undefined && capabilities.diagnosticProvider !== null && capabilities.diagnosticProvider !== false) pull = true
  const save = saveOptions(capabilities.textDocumentSync)
  connection.notify("initialized", {})
  if (options.settings !== null) connection.notify("workspace/didChangeConfiguration", { settings: options.settings })

  const waitForChange = (deadline: number, signal?: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        signal?.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, deadline - performance.now()))
      waiters.add(done)
      signal?.addEventListener("abort", done, { once: true })
      if (connection.isClosed()) done()
    })

  const fresh = (document: OpenDocument): Published | null => {
    const published = document.published
    if (published === null) return null
    if (published.version !== null) return published.version === document.version ? published : null
    return published.seq > document.sentAtSeq ? published : null
  }

  const pushed = async (document: OpenDocument, deadline: number, settleMs: number, signal?: AbortSignal) => {
    const version = document.version
    const ready = fresh(document)
    if (ready !== null) return ready.set
    while (fresh(document) === null) {
      if (performance.now() >= deadline || signal?.aborted || connection.isClosed() || document.version !== version) return null
      await waitForChange(deadline, signal)
    }
    // A server may publish more than once for one version (syntax first, then types): take what follows within the settle time.
    const settleUntil = Math.min(deadline, performance.now() + settleMs)
    while (performance.now() < settleUntil && !signal?.aborted && !connection.isClosed()) await waitForChange(settleUntil, signal)
    if (document.version !== version) return null
    return fresh(document)?.set ?? null
  }

  const pulled = async (document: OpenDocument, deadline: number, signal?: AbortSignal): Promise<DiagnosticSet | null> => {
    const version = document.version
    if (document.pulled?.version === version) return document.pulled.set
    // A server busy with the change may answer "cancelled, ask again": once more, if time is left.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const left = deadline - performance.now()
      if (left <= 0) return null
      try {
        const result = await connection.request(
          "textDocument/diagnostic",
          { textDocument: { uri: document.uri }, ...(document.resultId === null ? {} : { previousResultId: document.resultId }) },
          { timeoutMs: left, signal },
        )
        if (document.version !== version || !isObject(result)) return null
        if (typeof result.resultId === "string") document.resultId = result.resultId
        const set =
          result.kind === "unchanged" ? (document.pulled?.set ?? null) : result.kind === "full" ? parseDiagnostics(result.items) : null
        if (set === null) return null
        document.pulled = { version, set }
        return set
      } catch (error) {
        if (error instanceof LspError && error.kind === "rpc" && error.rpc?.code === -32802) continue
        return null
      }
    }
    return null
  }

  return {
    connection,
    get pull() {
      return pull
    },
    saveOptions: save,
    serverName: serverInfo,
    document: (uri) => documents.get(uri),
    open(path, languageId, text) {
      const uri = pathToFileURL(path).href
      const document: OpenDocument = { uri, languageId, version: 1, text, sentAtSeq: seq, published: null, pulled: null, resultId: null }
      documents.set(uri, document)
      connection.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } })
      return document
    },
    change(document, text) {
      document.version += 1
      document.text = text
      document.sentAtSeq = seq
      document.pulled = null
      connection.notify("textDocument/didChange", { textDocument: { uri: document.uri, version: document.version }, contentChanges: [{ text }] })
    },
    save(document) {
      if (save === null) return
      connection.notify("textDocument/didSave", { textDocument: { uri: document.uri }, ...(save.includeText ? { text: document.text } : {}) })
    },
    close(document) {
      documents.delete(document.uri)
      connection.notify("textDocument/didClose", { textDocument: { uri: document.uri } })
    },
    diagnostics: (document, deadline, settleMs, signal) => (pull ? pulled(document, deadline, signal) : pushed(document, deadline, settleMs, signal)),
    openCount: () => documents.size,
    async shutdown(graceMs) {
      if (!connection.isClosed()) {
        await connection.request("shutdown", null, { timeoutMs: graceMs }).catch(() => {})
        connection.notify("exit", null)
      }
      await connection.close()
    },
  }
}

/** Whether and how the server wants `didSave`. Without `textDocumentSync.save` it is still sent (cheap, and some servers check only on save) without text. */
function saveOptions(sync: unknown): { readonly includeText: boolean } | null {
  if (!isObject(sync)) return { includeText: false }
  if (sync.save === false) return null
  if (isObject(sync.save)) return { includeText: sync.save.includeText === true }
  return { includeText: false }
}

function lookup(settings: Json | null, section: string | null): Json | null {
  if (settings === null) return null
  if (section === null || section === "") return settings
  let value: Json | undefined = settings
  for (const part of section.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null
    value = (value as Record<string, Json>)[part]
  }
  return value ?? null
}

function basename(path: string): string {
  return path.split("/").filter((part) => part !== "").pop() ?? path
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
