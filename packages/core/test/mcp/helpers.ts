/** Helpers for the MCP tests: scripted servers as configuration, real temporary directories, registries that are always stopped. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { type McpConfigSection, type McpServerConfig, resolveMcpConfig } from "../../src/mcp/config.ts"
import { type McpRegistry, type McpRegistryOptions, createMcpRegistry } from "../../src/mcp/registry.ts"
import type { BlobRef } from "../../src/content.ts"
import type { ToolContext } from "../../src/tool/tool.ts"

export const STDIO_SERVER = join(import.meta.dir, "fixtures", "stdio-server.ts")
export const HOST_SCRIPT = join(import.meta.dir, "fixtures", "host.ts")

type ServerFields = NonNullable<McpConfigSection["servers"]>[string]

/** A stdio server running the scripted fixture with these flags. */
export function fixtureServer(flags: readonly string[] = [], fields: Omit<ServerFields, "command" | "args"> = {}): ServerFields {
  return { command: process.execPath, args: [STDIO_SERVER, ...flags], ...fields }
}

export function configOf(servers: Record<string, ServerFields>): McpServerConfig[] {
  return [...resolveMcpConfig({ servers }).servers]
}

const dirs: string[] = []
const registries: McpRegistry[] = []
const cleanups: (() => Promise<void> | void)[] = []

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-mcp-"))
  dirs.push(dir)
  return dir
}

/** A registry that `cleanup` stops. Short backoff and probe so the tests are quick. */
export function registry(servers: McpServerConfig[], options: Partial<McpRegistryOptions> = {}): McpRegistry {
  const created = createMcpRegistry({
    servers,
    cwd: process.cwd(),
    probeMs: 300,
    graceMs: 500,
    backoff: { initialMs: 100, maxMs: 400, stableMs: 60_000 },
    dropAfterMs: 300,
    ...options,
  })
  registries.push(created)
  return created
}

export function onCleanup(fn: () => Promise<void> | void) {
  cleanups.push(fn)
}

export async function cleanup() {
  await Promise.all(registries.splice(0).map((created) => created.stop()))
  for (const fn of cleanups.splice(0)) await fn()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

export function readLog(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line !== "")
  } catch {
    return []
  }
}

let calls = 0

/** A tool context for the bridge tools, with a blob store that records what it was given. */
export function toolContext(options: { signal?: AbortSignal; blobs?: { bytes: Uint8Array; mediaType: string }[]; progress?: string[] } = {}): ToolContext {
  calls += 1
  return {
    sessionId: "ses_test" as SessionId,
    messageId: "msg_test" as MessageId,
    callId: `call_${calls}` as CallId,
    cwd: process.cwd(),
    signal: options.signal ?? createInterrupt().signal,
    progress: (update) => options.progress?.push(update.text),
    putBlob: (bytes, mediaType): BlobRef => {
      options.blobs?.push({ bytes, mediaType })
      return { hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), mediaType }
    },
  }
}

export const never = new AbortController().signal
