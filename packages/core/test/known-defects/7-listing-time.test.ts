/**
 * Known defect 7 (a measurement, not a `test.failing`): listing sessions is slow.
 *
 * Reported: `--list-sessions` took 1.2 to 4.3 s with about 180 sessions in
 * the data directory, on a loaded two-core machine. The design says a
 * listing costs one `readdir`, two `stat` calls per session and one small
 * read per changed session (docs/architecture.md, "Listing without opening
 * every file").
 *
 * This builds a throwaway data directory with `<BRAND>_DEFECT7_SESSIONS`
 * (default 60; the report used 200) untitled one-turn sessions through the real assembly and a
 * scripted model, then times, in this process:
 * - the floor the design names: `readdir` plus two `stat` calls per session;
 * - `Engine.listSessions` cold (no `index.db`), then warm, several times;
 * - what the ACP server does per listed session on top of the listing: an
 *   untitled session's title is derived from its log (`titleOf` in
 *   `packages/acp/src/server.ts`: `engine.readEvents(id, { limit: 60 })`,
 *   a read-only connection per session, and the cache of derived titles is
 *   per server process, so cold in every `--list-sessions`, whose server
 *   child lives for that one listing);
 * and, through the CLI from source with `XDG_DATA_HOME` pointing at the
 * throwaway directory: `--version` (process start), and `--list-sessions`
 * (start, the ACP server child, the listing, the titles). Only a generous
 * bound is asserted. The numbers and what they mean are in the report.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import { brand } from "../../src/brand.ts"
import type { SessionId } from "../../src/id.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"

const COUNT = Number(process.env[`${brand.binary.toUpperCase()}_DEFECT7_SESSIONS`] ?? 60)
const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-defect-7-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const CLI = resolve(import.meta.dir, "../../../cli/src/main.ts")
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const spread = (values: readonly number[]) => `median ${median(values).toFixed(0)} ms (${Math.min(...values).toFixed(0)}-${Math.max(...values).toFixed(0)})`
const time = <T>(work: () => T): [T, number] => {
  const start = performance.now()
  const value = work()
  return [value, performance.now() - start]
}

describe("known defect 7: listing sessions", () => {
  test(
    "measures where the time of a listing goes, in-process and through the CLI",
    async () => {
      // XDG_DATA_HOME/<brand.directory> is the data directory the CLI finds.
      const data = join(root, "share", brand.directory)
      const cwd = join(root, "project")
      mkdirSync(cwd, { recursive: true })
      const options = { dataDir: data, engine: { approval: null, loadConfig: null, discover: () => [] } }

      // ---- the data directory: COUNT untitled one-turn sessions, as the CLI leaves them.
      const made = performance.now()
      {
        const provider = new FakeProvider(Array.from({ length: COUNT }, (_, index) => [script.text(`Answer ${index}.`)]))
        const harness = createHarness({ ...options, provider, log: () => {} })
        for (let index = 0; index < COUNT; index += 1) {
          const session = harness.engine.createSession({ cwd, settings: { model: "gpt-test", reasoningEffort: null } })
          session.send(`Question number ${index}: what does module ${index} export?`)
          await session.settled()
          await session.close()
        }
        await harness.close()
      }
      const madeMs = performance.now() - made

      // ---- in-process.
      const harness = createHarness({ ...options, provider: new FakeProvider(), log: () => {} })
      const lines: string[] = [`defect 7: ${COUNT} sessions made in ${(madeMs / 1000).toFixed(1)} s`]
      try {
        const sessionsDir = join(data, "sessions")
        const floor: number[] = []
        for (let round = 0; round < 5; round += 1)
          floor.push(
            time(() => {
              for (const name of readdirSync(sessionsDir)) {
                if (!name.endsWith(".db")) continue
                statSync(join(sessionsDir, name), { bigint: true })
                try {
                  statSync(join(sessionsDir, `${name}-wal`), { bigint: true })
                } catch {}
              }
            })[1],
          )
        rmSync(join(data, "index.db"), { force: true })
        const [listed, cold] = time(() => harness.engine.listSessions({ cwd }))
        expect(listed).toHaveLength(COUNT)
        // The cache uses a row only when it was checked more than two seconds after the file last changed.
        await Bun.sleep(2100)
        const second = time(() => harness.engine.listSessions({ cwd }))[1]
        const warm: number[] = []
        for (let round = 0; round < 5; round += 1) warm.push(time(() => harness.engine.listSessions({ cwd }))[1])
        const titles: number[] = []
        for (let round = 0; round < 3; round += 1)
          titles.push(time(() => listed.forEach((summary) => harness.engine.readEvents(summary.session.id as SessionId, { limit: 60 })))[1])
        lines.push(
          `  readdir + 2 stats per session: ${spread(floor)}`,
          `  Engine.listSessions: cold ${cold.toFixed(0)} ms; the next (racy rows read again) ${second.toFixed(0)} ms; warm ${spread(warm)}`,
          `  the ACP server's title per untitled session (readEvents, limit 60, each): ${spread(titles)} for ${COUNT}`,
        )
        expect(median(warm)).toBeLessThan(30_000)
      } finally {
        await harness.close()
      }

      // ---- through the CLI, from source: the process, the ACP server child, the listing and the titles.
      const env = { ...process.env, XDG_DATA_HOME: join(root, "share"), XDG_CONFIG_HOME: join(root, "config"), NO_COLOR: "1" }
      const run = (args: string[]) => {
        const start = performance.now()
        const child = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
        return { ms: performance.now() - start, code: child.exitCode, out: child.stdout.toString(), err: child.stderr.toString() }
      }
      const version = [1, 2, 3].map(() => run(["--version"]))
      const listing = [1, 2, 3].map(() => run(["--list-sessions"]))
      expect(listing.every((item) => item.code === 0)).toBe(true)
      const rows = listing[0]!.out.trim().split("\n").length
      lines.push(
        `  CLI --version (process start): ${spread(version.map((item) => item.ms))}`,
        `  CLI --list-sessions (${rows} lines): ${spread(listing.map((item) => item.ms))}`,
      )
      console.log(lines.join("\n"))
      expect(median(listing.map((item) => item.ms))).toBeLessThan(60_000)
    },
    { timeout: 600_000 },
  )
})
