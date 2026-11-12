/**
 * A long-lived harness process as the `acp` server builds it: the real
 * assembly on a data directory, told to fire wake-ups (`wake.run`), with a
 * scripted model that answers every turn in one line. Used by
 * `wake-servers.test.ts` to run several of them at once.
 *
 *   bun wake-server.ts <data dir> <webhook port>
 *
 * It prints `ready` once the engine (and with it the scheduler) is up, runs
 * until its standard input closes, shuts down as the server does and exits 0.
 */
import { createHarness } from "../../../src/assembly.ts"
import { resolveConfig } from "../../../src/config/schema.ts"
import { FakeProvider, script } from "../../../src/testing/fake-provider.ts"

const [dataDir, port] = process.argv.slice(2)
if (dataDir === undefined || port === undefined) throw new Error("usage: wake-server.ts <data dir> <webhook port>")

// Every model call is answered, however many there are: the test counts the turns, not the calls.
const answers = Array.from({ length: 50 }, () => [script.text(`Handled by ${process.pid}.`)])
const harness = createHarness({
  dataDir,
  provider: new FakeProvider(answers),
  log: (line) => process.stderr.write(`${line}\n`),
  engine: {
    wake: { run: true, port: Number(port), scheduler: { maxIdleMs: 200, probeMs: 100 } },
    // Nothing of this machine's configuration, no snapshots and no sandbox: the test is about who fires.
    loadConfig: async (cwd) => ({ config: resolveConfig({}), projectDir: cwd }),
    snapshots: null,
    approval: null,
  },
})
// As the server does: the engine, and with it the scheduler and the listener, start now.
void harness.engine.wake()
console.log("ready")
for await (const _ of Bun.stdin.stream()) {
  // Runs until the parent closes the pipe.
}
await harness.close()
process.exit(0)
