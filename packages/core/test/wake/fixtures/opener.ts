/**
 * A harness process starting up: waits for the go file, opens the wake store and records one wake-up in it.
 * Used by `processes.e2e.test.ts` to start several on a store that does not exist yet.
 *
 *   bun opener.ts <wake dir> <go file>
 */
import { existsSync } from "node:fs"
import { openWakeStore } from "../../../src/wake/store.ts"

const [dir, goFile] = process.argv.slice(2) as [string, string]
while (!existsSync(goFile)) await Bun.sleep(1)
const store = openWakeStore({ dir })
const created = store.create({ sessionId: `ses_${process.pid}`, message: "hello", author: "user", trigger: { kind: "after", delayMs: 60_000 } })
store.close()
if (!created.ok) throw new Error(created.error)
