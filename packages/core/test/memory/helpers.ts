/** Shared fixtures for the memory tests: real temporary directories, a fixed clock, a tool context. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import type { Provenance } from "../../src/memory/entry.ts"
import { type MemoryStore, memoryPaths, openMemoryStore } from "../../src/memory/store.ts"
import { noBlobStore, type ToolContext } from "../../src/tool/tool.ts"

const dirs: string[] = []
/**
 * Removes every directory `tempDir` made. Each test file registers it itself (`afterEach(cleanup)`): a hook
 * registered in this module would run only for the first file that imports it in a run.
 */
export const cleanup = () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function tempDir(prefix = "wl-memory-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** A clock that moves only when told to. */
export function clock(start = "2026-11-12T09:00:00Z") {
  let now = new Date(start)
  return {
    now: () => now,
    set: (iso: string) => {
      now = new Date(iso)
    },
    advanceDays: (days: number) => {
      now = new Date(now.getTime() + days * 86_400_000)
    },
  }
}

/** A store on a fresh data directory with a project directory, and sequential IDs. */
export function fixture(options: { start?: string; inRepository?: boolean } = {}) {
  const base = tempDir()
  const projectDir = join(base, "repo")
  const time = clock(options.start)
  let counter = 0
  const paths = memoryPaths({ dataDir: join(base, "data"), projectDir, inRepository: options.inRepository ?? false })
  const store = openMemoryStore({ paths, now: time.now, newId: () => `m_${String(++counter).padStart(4, "0")}` })
  return { base, projectDir, paths, store, time }
}

export function modelProvenance(session = "ses_1", extra: Partial<Provenance> = {}): Provenance {
  return { author: "model", session, message: "msg_1", call: "call_1", seq: null, quote: null, untrusted: false, ...extra }
}

export function userProvenance(session: string | null = "ses_1"): Provenance {
  return { author: "user", session, message: null, call: null, seq: null, quote: null, untrusted: false }
}

export function save(store: MemoryStore, text: string, extra: Partial<Parameters<MemoryStore["save"]>[0]> = {}) {
  const result = store.save({ text, kind: "fact", scope: "project", status: "active", provenance: modelProvenance(), ...extra })
  if (result.outcome !== "saved") throw new Error(`expected a save, got ${result.outcome}: ${"reason" in result ? result.reason : ""}`)
  return result.entry
}

export function context(session = "ses_1", cwd = "/tmp"): ToolContext {
  return {
    sessionId: session as SessionId,
    messageId: "msg_9" as MessageId,
    callId: "call_9" as CallId,
    cwd,
    signal: new AbortController().signal,
    progress: () => {},
    putBlob: noBlobStore,
  }
}
