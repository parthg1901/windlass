import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { waitFor } from "../../src/testing/wait.ts"
import { type SandboxPlan, type SandboxPolicy, type SandboxUnavailable, detectSandbox, sandboxCommand } from "../../src/sandbox/index.ts"

const created: string[] = []

/**
 * A fresh directory, preferring /var/tmp: inside the sandbox /tmp is a private
 * tmpfs, so a sibling under /tmp would be invisible rather than read-only and
 * the "write outside fails" tests would prove less.
 */
export function tempDir(label: string) {
  const base = writable("/var/tmp") ? "/var/tmp" : tmpdir()
  const dir = mkdtempSync(join(base, `${brand.directory}-sandbox-test-${label}-`))
  created.push(dir)
  return dir
}

export function removeTempDirs() {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

function writable(path: string) {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

const detection = detectSandbox()
/** Why the real-process tests cannot run here, or null when bwrap works. */
export const skipReason =
  process.platform !== "linux"
    ? `real-process tests need Linux with bubblewrap (this is ${process.platform})`
    : detection.available
      ? null
      : `bubblewrap unavailable: ${detection.reason}${detection.detail ? ` [${detection.detail}]` : ""}`
if (skipReason) console.warn(`[sandbox tests] SKIPPING real-process tests: ${skipReason}`)

export function plan(policy: SandboxPolicy, shell: string, cwd: string, env?: Record<string, string | undefined>): SandboxPlan {
  const result = sandboxCommand(policy, { shell, shellPath: "/bin/bash", cwd }, { env })
  if (result.kind !== "ready") throw new Error(`sandbox unavailable: ${(result as SandboxUnavailable).reason}`)
  return result
}

/** Spawns like the shell tool does: detached, stdin ignored, both streams piped. */
export function spawnPlan(p: SandboxPlan) {
  return Bun.spawn(p.argv, { env: p.env, cwd: p.cwd, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}

export async function run(p: SandboxPlan) {
  const child = spawnPlan(p)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code, signal: child.signalCode }
}

/** Host pids of every live descendant of `root`, found through /proc. */
export function descendants(root: number): number[] {
  const parents = new Map<number, number[]>()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readOrNull(`/proc/${entry}/stat`)
    if (!stat) continue
    // Fields after the parenthesised command name: state, ppid, ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const ppid = Number(fields[1])
    parents.set(ppid, [...(parents.get(ppid) ?? []), Number(entry)])
  }
  const walk = (pid: number): number[] => (parents.get(pid) ?? []).flatMap((child) => [child, ...walk(child)])
  return walk(root)
}

/** Alive and not a zombie. */
export function isRunning(pid: number) {
  const stat = readOrNull(`/proc/${pid}/stat`)
  if (!stat) return false
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
}

/** Whether `condition` came to hold within `ms`. */
export async function waitUntil(condition: () => boolean, ms: number) {
  return waitFor(condition, { timeoutMs: ms, intervalMs: 20 }).then(
    () => true,
    () => false,
  )
}

function readOrNull(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
