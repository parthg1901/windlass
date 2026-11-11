/**
 * Snapshots a temporary project, changes it with plain shell commands (the way
 * an agent's shell tool would), shows the diff, restores, and shows that the
 * project is back. Everything lives in one temporary directory, removed at the end.
 *
 *   bun scripts/snapshot-demo.ts
 */
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { openSnapshots } from "../packages/core/src/snapshot/index.ts"

const root = mkdtempSync(join(tmpdir(), `${brand.directory}-snapshot-demo-`))
const project = join(root, "project")
try {
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\n",
    "README.md": "# demo\n",
    "src/math.ts": "export const add = (a: number, b: number) => a + b\n",
    "src/old.ts": "export const legacy = true\n",
    "scripts/build.sh": "#!/bin/sh\necho build\n",
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true })
    writeFileSync(join(project, path), content)
  }
  shell("git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm init")
  shell("mkdir -p node_modules/dep && echo 'module.exports = 1' > node_modules/dep/index.js")

  const snapshots = await openSnapshots(project, { dataDir: join(root, "data") })
  if (snapshots.kind !== "ready") {
    console.log(`Snapshots unavailable (${snapshots.reason}): ${snapshots.message}`)
    process.exit(1)
  }
  const userGit = fingerprint(join(project, ".git"))
  const original = fingerprint(project, true)
  const start = await snapshots.take({ session: "demo" })
  console.log(`Project: ${project}`)
  console.log(`Snapshot at step start: ${start.id} (${start.durationMs} ms, ${Object.keys(original).filter((key) => !key.endsWith("/")).length} files on disk, node_modules ignored)\n`)

  const commands = [
    "sed -i.bak 's/a + b/a + b + 0/' src/math.ts && rm src/math.ts.bak",
    "rm src/old.ts",
    "printf 'export const mul = (a: number, b: number) => a * b\\n' > src/mul.ts",
    "chmod +x scripts/build.sh",
    "ln -s ../README.md src/README.link",
    "head -c 3145728 /dev/zero > big.bin",
    "echo 'module.exports = 2' > node_modules/dep/index.js",
  ]
  console.log("The step runs shell commands:")
  for (const command of commands) {
    console.log(`  $ ${command}`)
    shell(command)
  }

  const end = await snapshots.take({ session: "demo" })
  console.log(`\nSnapshot at step end: ${end.id} (${end.durationMs} ms)`)
  for (const file of end.skipped) console.log(`  warning: ${file.path} not captured (${file.reason}${file.reason === "too_large" ? `, ${file.bytes} bytes` : ""}); it cannot be undone`)

  console.log(`\nchangedFiles: ${(await snapshots.changedFiles(start.id, end.id)).join(", ")}`)
  console.log("\ndiff:")
  for (const change of await snapshots.diff(start.id, end.id, { patch: true })) {
    const kinds = `${change.before?.kind ?? "-"} -> ${change.after?.kind ?? "-"}`
    console.log(`  ${change.status.padEnd(13)} ${change.path}  (${kinds})`)
    if (change.patch?.kind === "text") for (const line of change.patch.text.trimEnd().split("\n")) console.log(`      ${line}`)
    if (change.patch?.kind === "binary") console.log("      (binary)")
  }

  const preview = await snapshots.restore(start.id, { session: "demo", dryRun: true })
  console.log(`\nDry run of restore: would change ${preview.changes.length} paths; workspace untouched`)
  const restored = await snapshots.restore(start.id, { session: "demo" })
  console.log(`Restore: ${restored.kind}, ${restored.changes.length} paths changed; undo point ${restored.before}`)

  const after = fingerprint(project, true)
  const differences = [...new Set([...Object.keys(original), ...Object.keys(after)])].filter((key) => original[key] !== after[key]).sort()
  console.log(`\nWorkspace compared with before the step (content, modes, links):`)
  console.log(`  identical except: ${differences.join(", ") || "nothing"}`)
  console.log(`  (big.bin was never captured so restore left it alone; node_modules is ignored so its edit stays)`)
  console.log(`  user's .git unchanged: ${JSON.stringify(fingerprint(join(project, ".git"))) === JSON.stringify(userGit) ? "yes" : "NO"}`)
  console.log(`  git status: ${shell("git status --porcelain").trim().replace(/\n/g, ", ") || "clean"}`)

  const undo = await snapshots.restore(restored.before, { session: "demo" })
  console.log(`\nUndo of the restore: ${undo.changes.length} paths changed; src/mul.ts exists again: ${exists("src/mul.ts") ? "yes" : "no"}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

function shell(command: string) {
  const result = Bun.spawnSync(["bash", "-c", command], { cwd: project, env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" } })
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function exists(path: string) {
  try {
    lstatSync(join(project, path))
    return true
  } catch {
    return false
  }
}

function fingerprint(dir: string, skipGit = false): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (current: string, rel: string) => {
    for (const name of readdirSync(current).sort()) {
      if (skipGit && name === ".git") continue
      const path = join(current, name)
      const key = rel ? `${rel}/${name}` : name
      const info = lstatSync(path)
      if (info.isSymbolicLink()) out[key] = `link ${readlinkSync(path)}`
      else if (info.isDirectory()) {
        out[`${key}/`] = "dir"
        walk(path, key)
      } else out[key] = `${(info.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)}${skipGit ? "" : ` ${info.mtimeMs}`}`
    }
  }
  walk(dir, "")
  return out
}
