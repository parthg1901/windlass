/**
 * One harness process writing memory, for the concurrency tests:
 *   bun writer.ts <data dir> <project dir> <label> <count> <shared text>
 * Saves <count> distinct notes, then the shared note (which several writers save at once), then retracts its own
 * first note, and prints one JSON line with what happened.
 */
import { memoryPaths, openMemoryStore } from "../../../src/memory/store.ts"

const [dataDir, projectDir, label, count, shared] = process.argv.slice(2) as [string, string, string, string, string]
const store = openMemoryStore({ paths: memoryPaths({ dataDir, projectDir }) })
const provenance = { author: "model" as const, session: `ses_${label}`, message: null, call: null, seq: null, quote: null, untrusted: false }
const saved: string[] = []
for (let index = 0; index < Number(count); index += 1) {
  const result = store.save({ text: `Writer ${label} fact number ${index} about subsystem ${label}${index}`, kind: "fact", scope: "project", status: "active", provenance })
  if (result.outcome === "saved") saved.push(result.entry.id)
}
const sharedResult = store.save({ text: shared, kind: "fact", scope: "project", status: "active", provenance })
const retracted = store.retract(saved[0]!, "model", `writer ${label} retracts its first note`)
store.recordUsage({ type: "read", session: `ses_${label}`, at: new Date().toISOString(), query: "x", ids: saved })
console.log(JSON.stringify({ saved, shared: sharedResult.outcome, retracted: retracted.ok }))
