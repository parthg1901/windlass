import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { open, removeTempDirs, tempDir } from "./helpers.ts"

afterEach(removeTempDirs)

test("a second snapshot of an unchanged 20,000-file tree only stats files", async () => {
  // The 20,000 files are removed inside the test, under its own time limit: on macOS deleting them can take longer
  // than the few seconds a hook is allowed.
  try {
    const ws = tempDir("perf")
    for (let dir = 0; dir < 200; dir += 1) {
      mkdirSync(join(ws, `pkg${dir}`, "src"), { recursive: true })
      for (let file = 0; file < 100; file += 1) writeFileSync(join(ws, `pkg${dir}`, "src", `f${file}.ts`), `export const v${dir}_${file} = ${dir * 100 + file}\n`)
    }
    const snapshots = await open(ws)
    const timed = async () => {
      const started = performance.now()
      const snapshot = await snapshots.take({ session: "perf" })
      return { snapshot, ms: Math.round(performance.now() - started) }
    }
    const first = await timed()
    const second = await timed()
    for (let index = 0; index < 10; index += 1) writeFileSync(join(ws, `pkg${index * 7}`, "src", "f3.ts"), `changed ${index}\n`)
    const third = await timed()
    console.log(`20,000 files: first snapshot ${first.ms} ms, unchanged second ${second.ms} ms, after 10 edits ${third.ms} ms`)

    expect(second.snapshot.id).toBe(first.snapshot.id)
    expect(await snapshots.changedFiles(second.snapshot.id, third.snapshot.id)).toHaveLength(10)
    // Re-hashing every file would cost about as much as the first snapshot.
    expect(second.ms).toBeLessThan(first.ms / 2)
  } finally {
    removeTempDirs()
  }
}, 120_000)
