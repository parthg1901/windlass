/**
 * Another process working in a session: it creates one in the given working
 * directory and data directory, prints its ID, and holds it until its stdin
 * closes.
 *
 *   bun hold-session.ts <dataDir> <cwd>
 */
import { createHarness } from "@windlass/core"
import { FakeProvider } from "@windlass/core/testing"

const [dataDir, cwd] = process.argv.slice(2)
const harness = createHarness({ dataDir: dataDir!, provider: new FakeProvider([]), log: () => {} })
const session = harness.engine.createSession({ cwd: cwd!, settings: { model: "m", reasoningEffort: null } })
process.stdout.write(`${session.id}\n`)
for await (const _ of Bun.stdin.stream()) {
}
await harness.close()
