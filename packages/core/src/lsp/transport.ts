/**
 * A language server as a child process: JSON-RPC in `Content-Length` frames
 * on its stdin and stdout (`codec.ts`).
 *
 * The process handling is the MCP stdio transport's (`mcp/stdio.ts`), copied
 * because that channel frames messages by newline and keeps its process-group
 * and guard helpers private: the child runs in a process group of its own, so
 * whatever it starts goes with it; a guard process kills that group if the
 * harness dies without shutting down; closing ends stdin, waits, then sends
 * SIGTERM to the group, waits, then SIGKILL.
 *
 * What the server writes is untrusted: broken framing or an oversized message
 * ends the connection; stderr is kept only as a short tail.
 */
import type { Subprocess } from "bun"
import { createFrameDecoder, encodeMessage } from "./codec.ts"

export type RequestId = number | string

export type JsonRpcError = { readonly code: number; readonly message: string; readonly data?: unknown }

export type ServerRequestHandler = (method: string, params: unknown) => { readonly result: unknown } | { readonly error: JsonRpcError }

export class LspError extends Error {
  constructor(
    readonly kind: "start" | "closed" | "timeout" | "cancelled" | "rpc",
    message: string,
    readonly rpc: JsonRpcError | null = null,
  ) {
    super(message)
    this.name = "LspError"
  }
}

export interface ConnectionOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The child's whole environment. */
  readonly env: Readonly<Record<string, string>>
  readonly maxMessageBytes?: number
  /** How long to wait after closing stdin, and again after SIGTERM. Default 1000 ms. */
  readonly graceMs?: number
}

export interface Connection {
  readonly pid: number
  /** Rejects with `LspError` on an error answer, a closed connection, the timeout or the signal. */
  request(method: string, params: unknown, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<unknown>
  notify(method: string, params: unknown): void
  onNotification(handler: (method: string, params: unknown) => void): void
  onRequest(handler: ServerRequestHandler): void
  /** Resolves with the reason once nothing more can be carried. */
  readonly closed: Promise<string>
  isClosed(): boolean
  /** Ends the connection and the server's process group. Idempotent. */
  close(): Promise<void>
  stderrTail(): string
}

const STDERR_TAIL_BYTES = 4096

export function openConnection(options: ConnectionOptions): Connection {
  const graceMs = options.graceMs ?? 1000
  let child: Subprocess<"pipe", "pipe", "pipe">
  try {
    child = Bun.spawn([options.command, ...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
  } catch (error) {
    throw new LspError("start", `could not start ${JSON.stringify(options.command)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const group = processGroup(child.pid, graceMs)
  const guard = guardGroup(child.pid)
  const decoder = createFrameDecoder({ maxMessageBytes: options.maxMessageBytes })

  let nextId = 1
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: LspError) => void }>()
  let notificationHandler: (method: string, params: unknown) => void = () => {}
  let requestHandler: ServerRequestHandler = (method) => ({ error: { code: -32601, message: `method not found: ${method}` } })
  let stderrTail = ""
  let closeReason: string | null = null
  let closing: Promise<void> | null = null
  let resolveClosed: (reason: string) => void = () => {}
  const closed = new Promise<string>((resolve) => (resolveClosed = resolve))

  const finish = (reason: string) => {
    if (closeReason !== null) return
    closeReason = reason
    resolveClosed(reason)
    for (const entry of pending.values()) entry.reject(new LspError("closed", reason))
    pending.clear()
  }

  const write = (message: object) => {
    if (closeReason !== null) return false
    try {
      child.stdin.write(encodeMessage(message))
      void Promise.resolve(child.stdin.flush()).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  const dispatch = (message: unknown) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return
    const m = message as Record<string, unknown>
    const hasId = typeof m.id === "number" || typeof m.id === "string"
    if (typeof m.method === "string") {
      if (!hasId) return notificationHandler(m.method, m.params)
      let answer: ReturnType<ServerRequestHandler>
      try {
        answer = requestHandler(m.method, m.params)
      } catch (error) {
        answer = { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }
      }
      write("result" in answer ? { id: m.id, result: answer.result ?? null } : { id: m.id, error: answer.error })
      return
    }
    if (!hasId) return
    const entry = pending.get(String(m.id))
    if (entry === undefined) return
    pending.delete(String(m.id))
    if (typeof m.error === "object" && m.error !== null) {
      const error = m.error as Record<string, unknown>
      const rpc = { code: typeof error.code === "number" ? error.code : -32603, message: typeof error.message === "string" ? error.message : "error", data: error.data }
      entry.reject(new LspError("rpc", rpc.message, rpc))
    } else entry.resolve(m.result ?? null)
  }

  void (async () => {
    const reader = child.stdout.getReader()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      const decoded = decoder.push(next.value)
      for (const message of decoded.messages) dispatch(message)
      if (decoded.error !== null) {
        finish(`the server wrote ${decoded.error}`)
        void close()
        return
      }
    }
  })()

  void (async () => {
    const reader = child.stderr.getReader()
    const text = new TextDecoder()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      stderrTail = (stderrTail + text.decode(next.value, { stream: true })).slice(-STDERR_TAIL_BYTES)
    }
  })()

  void child.exited.then(async (code) => {
    finish(child.signalCode !== null ? `the server process was killed by ${child.signalCode}` : `the server process exited with code ${code}`)
    await group.terminate()
    guard.release()
  })

  function close() {
    closing ??= (async () => {
      finish("the client closed the connection")
      try {
        child.stdin.end()
      } catch {
        // Already closed.
      }
      await Promise.race([child.exited, Bun.sleep(graceMs)])
      await group.terminate()
      guard.release()
      // After SIGKILL the process is gone in a moment; wait for it, so that a stopped registry has no live server.
      await Promise.race([child.exited, Bun.sleep(graceMs)])
    })()
    return closing
  }

  return {
    pid: child.pid,
    request: (method, params, requestOptions) =>
      new Promise((resolve, reject) => {
        if (closeReason !== null) return reject(new LspError("closed", closeReason))
        if (requestOptions.signal?.aborted) return reject(new LspError("cancelled", "cancelled before it was sent"))
        const id = nextId++
        const key = String(id)
        const settle = () => {
          clearTimeout(timer)
          requestOptions.signal?.removeEventListener("abort", onAbort)
        }
        const abandon = (error: LspError) => {
          if (!pending.delete(key)) return
          settle()
          write({ method: "$/cancelRequest", params: { id } })
          reject(error)
        }
        const onAbort = () => abandon(new LspError("cancelled", "cancelled"))
        const timer = setTimeout(() => abandon(new LspError("timeout", `${method} had no answer within ${requestOptions.timeoutMs} ms`)), Math.max(0, requestOptions.timeoutMs))
        pending.set(key, {
          resolve: (value) => {
            settle()
            resolve(value)
          },
          reject: (error) => {
            settle()
            reject(error)
          },
        })
        requestOptions.signal?.addEventListener("abort", onAbort, { once: true })
        if (!write({ id, method, params })) {
          pending.delete(key)
          settle()
          reject(new LspError("closed", closeReason ?? "could not write to the server"))
        }
      }),
    notify: (method, params) => {
      write({ method, params })
    },
    onNotification: (handler) => {
      notificationHandler = handler
    },
    onRequest: (handler) => {
      requestHandler = handler
    },
    closed,
    isClosed: () => closeReason !== null,
    close,
    stderrTail: () => stderrTail,
  }
}

/** The process group led by `pid`. `terminate` is idempotent. (As in `mcp/stdio.ts`.) */
function processGroup(pid: number, graceMs: number) {
  let terminating: Promise<void> | null = null
  const send = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }
  return {
    terminate: () => {
      terminating ??= (async () => {
        if (!send("SIGTERM")) return
        const deadline = performance.now() + graceMs
        while (performance.now() < deadline) {
          await Bun.sleep(25)
          if (!send(0)) return
        }
        send("SIGKILL")
      })()
      return terminating
    },
  }
}

/**
 * Kills the group led by `pid` if this process dies first, however it dies: a
 * small shell in a session of its own blocks reading a pipe only this process
 * holds open. Best effort. (As in `mcp/stdio.ts`.)
 */
function guardGroup(pid: number): { release: () => void } {
  try {
    const guard = Bun.spawn(["/bin/sh", "-c", 'read -r _; kill -s KILL -- "-$1" 2>/dev/null', "guard", String(pid)], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    })
    guard.unref()
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        try {
          guard.kill("SIGKILL")
        } catch {
          // Already gone.
        }
      },
    }
  } catch {
    return { release: () => {} }
  }
}
