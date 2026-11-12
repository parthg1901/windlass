/** Real temporary directories, a real `git` playing the user, and fingerprints of what must not change. */
import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { type SnapshotOptions, type Snapshots, openSnapshots } from "../../src/snapshot/index.ts"

const created: string[] = []
/** HOME for the user's git in tests, so the real ~/.gitconfig never applies. */
export const userHome = join(tmpdir(), `wl-snap-home-${process.pid}`)

/** A fresh temporary directory with symlinks resolved (macOS /var -> /private/var), removed by `removeTempDirs`. */
export function tempDir(label = "snap"): string {
  const dir = mkdtempSync(join(tmpdir(), `wl-${label}-`))
  created.push(dir)
  return Bun.spawnSync(["pwd", "-P"], { cwd: dir }).stdout.toString().trim()
}

export function removeTempDirs() {
  for (const dir of [...created.splice(0), userHome]) {
    // Tests make files unreadable or read-only; make everything removable first.
    Bun.spawnSync(["chmod", "-R", "u+rwx", dir])
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The environment for the "user's" own git: a private HOME, no system config, a fixed identity. */
export function userEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "User",
    GIT_AUTHOR_EMAIL: "user@example.com",
    GIT_COMMITTER_NAME: "User",
    GIT_COMMITTER_EMAIL: "user@example.com",
    LC_ALL: "C",
  }
}

/** Runs a shell command the way a user (or the agent's shell tool) would. Fails the test on a non-zero exit. */
export function sh(cwd: string, command: string, env: Record<string, string> = userEnv(userHome)): string {
  mkdirSync(env.HOME!, { recursive: true })
  const result = Bun.spawnSync(["bash", "-c", command], { cwd, env, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`\`${command}\` failed (${result.exitCode}): ${result.stderr.toString()}`)
  return result.stdout.toString()
}

export function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
}

/** Opens snapshots for `workspace` with a private data directory under the test's temp root. */
export async function open(workspace: string, options: SnapshotOptions = {}): Promise<Snapshots> {
  const snapshots = await openSnapshots(workspace, { dataDir: tempDir("data"), ...options })
  if (snapshots.kind !== "ready") throw new Error(`snapshots unavailable: ${snapshots.message}`)
  return snapshots
}

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** Every path in a snapshot, via the public diff against the empty tree. */
export async function filesIn(snapshots: Snapshots, id: string) {
  return (await snapshots.changedFiles(EMPTY_TREE as never, id as never)).sort()
}

/**
 * Every entry under `root` (excluding `.git` when asked): type, permission bits,
 * and content hash or link target. Two equal listings mean an identical tree.
 */
export function listing(root: string, options: { skipGit?: boolean; mtimes?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (options.skipGit && name === ".git") continue
      const path = join(dir, name)
      const key = rel === "" ? name : `${rel}/${name}`
      const info = lstatSync(path)
      const mtime = options.mtimes ? ` mtime=${info.mtimeMs}` : ""
      if (info.isSymbolicLink()) out[key] = `link -> ${readlinkSync(path)}`
      else if (info.isDirectory()) {
        out[`${key}/`] = `dir ${(info.mode & 0o777).toString(8)}${mtime}`
        walk(path, key)
      } else out[key] = `file ${(info.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)}${mtime}`
    }
  }
  walk(root, "")
  return out
}

/**
 * The user's repository state that must stay byte-identical: every file under
 * `.git` (content, mode, mtime), then `git status` and `git stash list`. The
 * listing comes first and status runs with GIT_OPTIONAL_LOCKS=0, so the
 * observer itself never refreshes the index.
 */
export function repositoryState(repo: string, home: string) {
  const files = listing(join(repo, ".git"), { mtimes: true })
  const env = { ...userEnv(home), GIT_OPTIONAL_LOCKS: "0" }
  const status = sh(repo, "git status --porcelain=v2 --branch --untracked-files=all --ignored", env)
  const stash = sh(repo, "git stash list", env)
  const refs = sh(repo, "git for-each-ref --format='%(objectname) %(refname)'", env)
  return { files, status, stash, refs }
}

export function expectSame<T>(actual: T, expected: T) {
  expect(actual).toEqual(expected)
}

/** Runs plain git against a snapshot repository, for assertions about its objects and integrity. */
export function privateGit(gitDir: string, args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_DIR: gitDir, HOME: gitDir, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
}
