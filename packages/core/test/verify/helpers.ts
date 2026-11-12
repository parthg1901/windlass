/** Real temporary project directories for the verify tests. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CheckConfig } from "../../src/config/schema.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { RunCheckOptions } from "../../src/verify/run.ts"

export { isRunning } from "../tools/helpers.ts"

const created: string[] = []

export function removeTempDirs() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-verify-")))
  created.push(root)
  const dir = join(root, "project")
  const spillDir = join(root, "spill")
  mkdirSync(dir)
  return {
    dir,
    spillDir,
    write: (name: string, content: string) => Bun.write(join(dir, name), content),
    options: (extra: Partial<RunCheckOptions> = {}): RunCheckOptions => ({ cwd: dir, spillDir, signal: createInterrupt().signal, graceMs: 500, ...extra }),
  }
}

export function check(name: string, command: string, extra: Partial<CheckConfig> = {}): CheckConfig {
  return { name, command, timeoutSeconds: 30, when: null, ...extra }
}

export async function expectGone(pids: number[], isRunning: (pid: number) => boolean, ms = 1000) {
  const deadline = performance.now() + ms
  while (pids.some(isRunning) && performance.now() < deadline) await Bun.sleep(20)
  return pids.filter(isRunning)
}
