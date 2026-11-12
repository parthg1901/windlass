/**
 * The stdio transport: the server is a child process that reads messages on
 * stdin and writes them on stdout, one JSON value per line.
 *
 * The child runs in a process group of its own, so the whole tree it starts
 * (a launcher that runs node that runs the server) is stopped together, and
 * a guard process kills that group if the harness dies without shutting down.
 * Shutdown follows the specification: close stdin, wait, then SIGTERM, then SIGKILL.
 *
 * What the server writes is untrusted. A line that is not JSON-RPC is counted
 * and ignored (some servers print a banner); a line longer than
 * `maxMessageBytes` ends the channel; stderr is kept only as a short tail.
 */
import type { Subprocess } from "bun"
import type { Channel, ChannelDiagnostics, OutgoingRequest, RequestHandler, RequestOptions, RpcOutcome } from "./channel.ts"
import { type Incoming, type JsonObject, McpError, excerpt, parseIncoming } from "./protocol.ts"

export interface StdioOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The child's whole environment. Nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>
  /** Default 32 MiB. */
  readonly maxMessageBytes?: number
  /** How long to wait after closing stdin, and again after SIGTERM. Default 2000 ms. */
  readonly graceMs?: number
}

const STDERR_TAIL_BYTES = 4096
const GARBAGE_SAMPLES = 3
const NEWLINE = 0x0a

/** Starts the server. Throws an `McpError` of kind `start` when the process cannot be started. */
export function openStdioChannel(options: StdioOptions): Channel {
  const maxMessageBytes = options.maxMessageBytes ?? 32 * 1024 * 1024
  const graceMs = options.graceMs ?? 2000
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
    throw new McpError("start", `could not start ${JSON.stringify(options.command)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const group = processGroup(child.pid, graceMs)
  const guard = guardGroup(child.pid)

  const pending = new Map<string, { resolve: (outcome: RpcOutcome) => void; reject: (error: McpError) => void }>()
  let notificationHandler: (message: Extract<Incoming, { kind: "notification" }>) => void = () => {}
  let requestHandler: RequestHandler | null = null
  let stderrTail = ""
  let garbageLines = 0
  const garbageSamples: string[] = []
  let closeReason: string | null = null
  let closing: Promise<void> | null = null
  let resolveClosed: (reason: string) => void = () => {}
  const closed = new Promise<string>((resolve) => (resolveClosed = resolve))

  const finish = (reason: string) => {
    if (closeReason !== null) return
    closeReason = reason
    // Resolved first, so whoever waits on a pending request already sees the channel as closed.
    resolveClosed(reason)
    for (const entry of pending.values()) entry.reject(new McpError("closed", reason))
    pending.clear()
  }

  const write = (message: object) => {
    if (closeReason !== null) return false
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
      void Promise.resolve(child.stdin.flush()).catch(() => {})
      return true
    } catch {
      return false
    }
  }

  const dispatch = (line: string) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      value = undefined
    }
    const message = value === undefined ? null : parseIncoming(value)
    if (message === null) {
      garbageLines += 1
      if (garbageSamples.length < GARBAGE_SAMPLES) garbageSamples.push(excerpt(line, 120))
      return
    }
    if (message.kind === "result" || message.kind === "error") {
      const entry = message.id === null ? undefined : pending.get(String(message.id))
      if (entry === undefined) return
      pending.delete(String(message.id))
      entry.resolve(message.kind === "result" ? { ok: true, result: message.result } : { ok: false, error: message.error, httpStatus: null })
      return
    }
    if (message.kind === "notification") {
      notificationHandler(message)
      return
    }
    const answer = requestHandler?.(message) ?? { error: { code: -32601, message: `method not found: ${message.method}`, data: undefined } }
    write("result" in answer ? { id: message.id, result: answer.result } : { id: message.id, error: answer.error })
  }

  void (async () => {
    const reader = child.stdout.getReader()
    let chunks: Uint8Array[] = []
    let length = 0
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) break
      let bytes = next.value
      for (let index = bytes.indexOf(NEWLINE); index !== -1; index = bytes.indexOf(NEWLINE)) {
        chunks.push(bytes.subarray(0, index))
        const line = decoder.decode(concat(chunks, length + index)).replace(/\r$/, "")
        chunks = []
        length = 0
        bytes = bytes.subarray(index + 1)
        if (line.trim() !== "") dispatch(line)
      }
      chunks.push(bytes)
      length += bytes.length
      if (length > maxMessageBytes) {
        finish(`the server wrote a message longer than ${maxMessageBytes} bytes`)
        void close()
        return
      }
    }
  })()

  void (async () => {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
      if (next.done) return
      stderrTail = (stderrTail + decoder.decode(next.value, { stream: true })).slice(-STDERR_TAIL_BYTES)
    }
  })()

  void child.exited.then(async (code) => {
    finish(child.signalCode !== null ? `the server process was killed by ${child.signalCode}` : `the server process exited with code ${code}`)
    // Whatever the server left running in its group goes with it.
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
    })()
    return closing
  }

  return {
    kind: "stdio",
    request: (message: OutgoingRequest, options: RequestOptions) =>
      new Promise<RpcOutcome>((resolve, reject) => {
        if (closeReason !== null) return reject(new McpError("closed", closeReason))
        if (options.signal.aborted) return reject(new McpError("cancelled", "cancelled before it was sent"))
        const key = String(message.id)
        const onAbort = () => {
          if (!pending.delete(key)) return
          const reason = options.signal.reason instanceof Error ? options.signal.reason.message : "cancelled"
          write({ method: "notifications/cancelled", params: { requestId: message.id, reason } })
          reject(new McpError("cancelled", reason))
        }
        pending.set(key, {
          resolve: (outcome) => {
            options.signal.removeEventListener("abort", onAbort)
            resolve(outcome)
          },
          reject: (error) => {
            options.signal.removeEventListener("abort", onAbort)
            reject(error)
          },
        })
        options.signal.addEventListener("abort", onAbort, { once: true })
        if (!write({ id: message.id, method: message.method, params: message.params })) {
          pending.delete(key)
          reject(new McpError("closed", closeReason ?? "could not write to the server"))
        }
      }),
    notify: async (method: string, params: JsonObject) => {
      write({ method, params })
    },
    onNotification: (handler) => {
      notificationHandler = handler
    },
    onRequest: (handler) => {
      requestHandler = handler
    },
    closed,
    close,
    diagnostics: (): ChannelDiagnostics => ({ pid: child.pid, stderrTail, garbageLines, garbageSamples: [...garbageSamples] }),
  }
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** The process group led by `pid`. `terminate` is idempotent: later calls wait for the first. */
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
 * Kills the group led by `pid` if this process dies first, however it dies:
 * a small shell in a session of its own blocks reading a pipe only this
 * process holds open. Best effort: if it cannot start, the server still runs.
 * (The same mechanism as the shell tool's.)
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
