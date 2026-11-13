/**
 * A harness process starting up: waits for the go file, opens the wake store and records one wake-up in it.
 * Used by `processes.e2e.test.ts` to start several on a store that does not exist yet. It writes `<go file>.ready-<pid>`
 * when it waits at the barrier.
 *
 *   bun opener.ts <wake dir> <go file>
 */
import { existsSync, writeFileSync } from "node:fs"
import { waitFor } from "../../../src/testing/wait.ts"
import { openWakeStore } from "../../../src/wake/store.ts"

const [dir, goFile] = process.argv.slice(2) as [string, string]
writeFileSync(`${goFile}.ready-${process.pid}`, "")
await waitFor(() => existsSync(goFile), { timeoutMs: 60_000, intervalMs: 1, what: "the go file" })
const store = openWakeStore({ dir })
const created = store.create({ sessionId: `ses_${process.pid}`, message: "hello", author: "user", trigger: { kind: "after", delayMs: 60_000 } })
store.close()
if (!created.ok) throw new Error(created.error)
