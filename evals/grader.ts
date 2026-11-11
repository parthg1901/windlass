/**
 * Helpers shared by the graders in tasks/<id>/check.ts. A grader judges the finished workspace, prints one line
 * and exits 0 (pass) or 1 (fail).
 */
import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

/** Files stored as `name.in` are copied into a workspace as `name`, so the repo's own `bun test` never sees them. */
export const STORED_SUFFIX = ".in"
/** Directories a runner or tool may add to a workspace; graders never treat them as changes. */
export const IGNORED_DIRS = new Set([".git", "node_modules"])

export function pass(message: string): never {
  console.log(`ok: ${message}`)
  process.exit(0)
}

export function fail(message: string): never {
  console.log(`fail: ${message}`)
  process.exit(1)
}

/** The finished workspace given on the command line. */
export function workspaceArg() {
  const dir = process.argv[2]
  if (!dir) fail("usage: bun check.ts <path-to-finished-workspace>")
  return dir
}

/** Every file under `dir`, keyed by its path relative to `dir` with `/` separators. */
export async function readTree(dir: string, stored = false) {
  const files = new Map<string, string>()
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(dir, path).split("\\").join("/")
      const name = stored && rel.endsWith(STORED_SUFFIX) ? rel.slice(0, -STORED_SUFFIX.length) : rel
      files.set(name, await Bun.file(path).text())
    }
  }
  await walk(dir)
  return files
}

/** The untouched workspace of the task whose grader is `checkUrl` (pass `import.meta.dir`). */
export function pristine(taskDir: string) {
  return readTree(join(taskDir, "workspace"), true)
}

/** Fails unless each listed file is byte-identical to the task's original. */
export async function requireUnchanged(taskDir: string, workspace: string, paths: string[]) {
  const original = await pristine(taskDir)
  for (const path of paths) {
    const before = original.get(path)
    if (before === undefined) throw new Error(`grader bug: ${path} is not in the task workspace`)
    const file = Bun.file(join(workspace, path))
    if (!(await file.exists())) fail(`${path} was deleted`)
    if ((await file.text()) !== before) fail(`${path} must not be changed`)
  }
}

/** Runs a command with a time limit and returns its exit code and combined output. */
export async function run(cmd: string[], cwd: string, timeoutSeconds = 60) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } })
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutSeconds * 1000)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, stdout, stderr, output: stdout + stderr }
}

/** The last non-empty line of some output, for one-line failure messages. */
export function lastLine(text: string) {
  return (text.trim().split("\n").filter((line) => line.trim() !== "").at(-1) ?? "(no output)").trim().slice(0, 200)
}

/** Imports a module from the workspace, so a grader can call the agent's code directly. Fails on a load error. */
export async function importFrom<T>(workspace: string, path: string): Promise<T> {
  try {
    return (await import(join(workspace, path))) as T
  } catch (error) {
    fail(`${path} could not be loaded: ${String(error).split("\n")[0]}`)
  }
}

/** The first line of some output that looks like an error or a failed test, else its last line. */
export function errorLine(text: string) {
  const line = text.split("\n").find((candidate) => /error|not ok|\bfail\b|\(fail\)/i.test(candidate) && !/\b0 fail/.test(candidate))
  return line ? line.trim().slice(0, 200) : lastLine(text)
}
