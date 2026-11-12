/**
 * Workspace snapshots: the whole working tree recorded as a git tree object in
 * a private git directory, so every step can be diffed and undone. See
 * README.md for what is and is not captured.
 */
import { createHash, randomBytes } from "node:crypto"
import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { brand } from "../brand.ts"
import { DEFAULT_PATCH_LIMITS, type FileChange, type FileKind, type PatchLimits, attachPatches, parseRaw } from "./diff.ts"
import { ATTRIBUTE_OVERRIDES, type GitContext, type RunOptions, SnapshotError, probeGit, runGit } from "./git.ts"

export { SnapshotError } from "./git.ts"
export type { ChangeStatus, FileChange, FileKind, FilePatch, FileState, PatchLimits } from "./diff.ts"

/** A git tree hash. Equal ids mean equal snapshot contents. */
export type SnapshotId = string & { readonly __snapshotId: unique symbol }

export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024

export interface SnapshotOptions {
  /** Holds one private git directory per workspace. Default `<XDG_DATA_HOME or ~/.local/share>/<brand.directory>/snapshots`. */
  readonly dataDir?: string
  /** Files not captured before and larger than this are skipped and reported. Default 2 MiB. */
  readonly maxFileBytes?: number
  /** The git executable. Default `git` on PATH. */
  readonly gitPath?: string
}

export type SnapshotUnavailable = {
  readonly kind: "unavailable"
  readonly reason: "git_not_found" | "git_too_old" | "workspace_invalid" | "storage_failed"
  readonly message: string
}

export type SkippedFile =
  | { readonly path: string; readonly reason: "too_large"; readonly bytes: number }
  /** Could not be read (permissions). A path ending in `/` is a directory git could not open. */
  | { readonly path: string; readonly reason: "unreadable" }

export type Snapshot = {
  readonly id: SnapshotId
  readonly session: string
  readonly takenAt: number
  /** Untracked files left out of this snapshot. Restore never deletes or overwrites them. */
  readonly skipped: readonly SkippedFile[]
  /** Directories holding their own git repository (nested repos, submodules). Recorded, never descended into. */
  readonly nestedRepositories: readonly string[]
  readonly durationMs: number
}

export type SnapshotRef = { readonly id: SnapshotId; readonly session: string; readonly takenAt: number; readonly ref: string }

export type KeptPath = {
  readonly path: string
  /** Why restore left it as it is. */
  readonly reason: "ignored" | "nested_repository" | "not_captured"
}

export type RestoreResult = {
  readonly kind: "restored" | "dry_run" | "blocked"
  /**
   * The workspace as it was just before the restore; restoring it undoes the
   * restore. For a dry run it is taken without a session, so it is not kept
   * by retention and is garbage-collected after the grace period.
   */
  readonly before: SnapshotId
  /** From `before` to the target: what was (or would be) changed. */
  readonly changes: readonly FileChange[]
  readonly kept: readonly KeptPath[]
  /** For `blocked`: git's explanation (an uncaptured file in the way, or a file changed during the restore). Nothing was changed. */
  readonly message?: string
}

export interface Snapshots {
  readonly kind: "ready"
  /** The workspace with symlinks resolved. */
  readonly workspace: string
  /** The private git directory for this workspace. */
  readonly gitDir: string
  take(options: { readonly session: string }): Promise<Snapshot>
  diff(from: SnapshotId, to: SnapshotId, options?: { readonly patch?: boolean | PatchLimits }): Promise<FileChange[]>
  /** Paths (relative to the workspace) that differ between two snapshots. Compares trees only; never reads the workspace. */
  changedFiles(from: SnapshotId, to: SnapshotId): Promise<string[]>
  restore(target: SnapshotId, options: { readonly session: string; readonly paths?: readonly string[]; readonly dryRun?: boolean }): Promise<RestoreResult>
  /** Newest first. */
  list(options?: { readonly session?: string }): Promise<SnapshotRef[]>
  prune(options: PruneOptions): Promise<{ readonly removed: readonly SnapshotRef[]; readonly remaining: number }>
}

export interface PruneOptions {
  /** Only this session's snapshots are considered. Default: every session of the workspace. */
  readonly session?: string
  readonly olderThanMs?: number
  /** Keep the newest `keepLast` of the considered snapshots. `0` drops them all. */
  readonly keepLast?: number
  readonly now?: number
  /** Unreferenced objects younger than this survive gc, so a snapshot being taken concurrently is never cut. Default 3600. */
  readonly graceSeconds?: number
  /**
   * Snapshots that are never removed, whatever their age or number: the ones
   * a revert or an undo of the session could still restore. One ref is kept
   * for each; they do not count toward `keepLast`. A function is called after
   * the refs were listed, so that a snapshot recorded while the prune runs is
   * either not among them or already named by it.
   */
  readonly protect?: readonly SnapshotId[] | (() => readonly SnapshotId[])
  /**
   * Also remove a ref when a newer ref that is kept names the same snapshot.
   * An unchanged workspace is recorded as the same tree again and again, and
   * one ref keeps it alive.
   */
  readonly dedupe?: boolean
  /**
   * `always` (the default) collects unreferenced objects now. `auto` leaves
   * it to git's own thresholds (`git gc --auto`), which costs almost nothing
   * when there is little to collect: for a prune that runs after every turn.
   */
  readonly gc?: "always" | "auto"
}

export function defaultSnapshotDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), brand.directory, "snapshots")
}

export async function openSnapshots(workspace: string, options: SnapshotOptions = {}): Promise<Snapshots | SnapshotUnavailable> {
  const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }
  const probe = probeGit(options.gitPath, baseEnv)
  if (probe.kind === "unavailable") return probe
  const root = await realpath(workspace).catch(() => null)
  if (root === null || !(await stat(root)).isDirectory())
    return { kind: "unavailable", reason: "workspace_invalid", message: `${workspace} is not a directory` }
  const gitDir = join(options.dataDir ?? defaultSnapshotDir(), createHash("sha256").update(root).digest("hex").slice(0, 32))
  const context: GitContext = { git: probe.git, gitDir, baseEnv }
  try {
    await ensureRepository(context, root)
  } catch (error) {
    return { kind: "unavailable", reason: "storage_failed", message: error instanceof Error ? error.message : String(error) }
  }
  return createSnapshots(context, root, resolve(workspace), options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES)
}

/**
 * Writes the files of snapshot `id` of `workspace` into the directory
 * `into`, which is created when missing: a copy of the workspace as it was
 * when the snapshot was taken, to work in without touching the original (a
 * fork that gets its own directory, a replay that runs tools for real).
 *
 * The workspace itself is never read or written and need not exist any more:
 * the snapshot lives in the private git directory that belongs to its path.
 * What the copy holds is what a snapshot holds (see the README): no ignored
 * file (so no `node_modules`), no untracked file over the size limit,
 * nothing inside a nested repository, nothing outside the workspace.
 * Existing files in `into` that the snapshot also has are overwritten;
 * others are left alone. Returns how many files were written.
 */
export async function exportSnapshot(workspace: string, id: string, into: string, options: SnapshotOptions = {}): Promise<{ readonly files: number } | SnapshotUnavailable> {
  const baseEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) }
  const probe = probeGit(options.gitPath, baseEnv)
  if (probe.kind === "unavailable") return probe
  // The private directory is named after the workspace's real path, which is the path itself once the directory is gone.
  const root = await realpath(workspace).catch(() => resolve(workspace))
  const gitDir = join(options.dataDir ?? defaultSnapshotDir(), createHash("sha256").update(root).digest("hex").slice(0, 32))
  if (!(await exists(join(gitDir, "HEAD")))) return { kind: "unavailable", reason: "storage_failed", message: `no snapshot of ${workspace} was ever recorded` }
  const context: GitContext = { git: probe.git, gitDir, baseEnv }
  await mkdir(into, { recursive: true })
  const target = await realpath(into)
  const index = join(gitDir, `index.tmp-export-${process.pid}-${(counter += 1)}-${randomBytes(4).toString("hex")}`)
  const run = { cwd: target, workTree: target, indexFile: index }
  try {
    const kind = new TextDecoder().decode((await runGit(context, ["cat-file", "-t", assertId(id as SnapshotId)], { ...run, okCodes: [0, 128] })).stdout).trim()
    if (kind !== "tree") throw new SnapshotError(`${id} is not a snapshot of ${workspace} (it may have been dropped by retention)`)
    await runGit(context, ["read-tree", id], run)
    await runGit(context, ["checkout-index", "--all", "--force"], run)
    const listed = new TextDecoder().decode((await runGit(context, ["ls-files", "-z"], run)).stdout)
    return { files: splitNul(listed).length }
  } finally {
    await rm(index, { force: true })
  }
}

/** Creates the private bare repository atomically (init elsewhere, then rename), so concurrent openers agree. */
async function ensureRepository(context: GitContext, workspace: string) {
  if (!(await exists(join(context.gitDir, "HEAD")))) {
    await mkdir(dirname(context.gitDir), { recursive: true, mode: 0o700 })
    const staging = `${context.gitDir}.init-${process.pid}-${randomBytes(4).toString("hex")}`
    await runGit({ ...context, gitDir: staging }, ["init", "--bare", "--quiet", "--template="], { cwd: dirname(context.gitDir) })
    await rename(staging, context.gitDir).catch(async (error: NodeJS.ErrnoException) => {
      await rm(staging, { recursive: true, force: true })
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error
    })
  }
  await mkdir(join(context.gitDir, "info"), { recursive: true })
  const attributes = join(context.gitDir, "info", "attributes")
  if ((await readFile(attributes, "utf8").catch(() => "")) !== ATTRIBUTE_OVERRIDES) await writeFile(attributes, ATTRIBUTE_OVERRIDES)
  await writeFile(join(context.gitDir, "workspace"), `${workspace}\n`)
}

type Location = {
  /** GIT_WORK_TREE: the workspace, or the root of the repository it sits in (so that repository's `.gitignore` files apply). */
  readonly workTree: string
  /** The workspace relative to `workTree`, `""` or ending in `/`. */
  readonly prefix: string
}

type Capture = {
  readonly id: SnapshotId
  readonly location: Location
  /** A private index holding the captured state with fresh stat data. */
  readonly index: string
  readonly skipped: SkippedFile[]
  readonly nested: string[]
}

const MODES: Record<FileKind, string> = { file: "100644", executable: "100755", symlink: "120000", submodule: "160000" }
let counter = 0

function createSnapshots(context: GitContext, workspace: string, given: string, maxFileBytes: number): Snapshots {
  const sharedIndex = join(context.gitDir, "index")
  const sharedIndexRoot = join(context.gitDir, "index-root")
  const git = (args: readonly string[], options: Partial<RunOptions> = {}) => runGit(context, args, { cwd: workspace, ...options })
  const text = async (args: readonly string[], options: Partial<RunOptions> = {}) => new TextDecoder().decode((await git(args, options)).stdout)

  return {
    kind: "ready",
    workspace,
    gitDir: context.gitDir,

    async take(options) {
      const started = performance.now()
      const takenAt = Date.now()
      const capture = await captureWorkspace()
      try {
        await git(["update-ref", refName(options.session, takenAt), capture.id])
        await commitIndex(capture)
      } finally {
        await rm(capture.index, { force: true })
      }
      return {
        id: capture.id,
        session: options.session,
        takenAt,
        skipped: capture.skipped,
        nestedRepositories: capture.nested,
        durationMs: Math.round(performance.now() - started),
      }
    },

    async diff(from, to, options = {}) {
      const changes = parseRaw(await text(["diff-tree", "-r", "-z", "--no-renames", assertId(from), assertId(to)]))
      if (!options.patch || changes.length === 0) return changes
      const limits = { ...DEFAULT_PATCH_LIMITS, ...(options.patch === true ? {} : options.patch) }
      const output = await git(
        ["diff-tree", "-p", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", from, to],
        { maxStdout: limits.maxTotalBytes },
      )
      return attachPatches(changes, output.stdout, !output.truncated, limits)
    },

    async changedFiles(from, to) {
      return splitNul(await text(["diff-tree", "-r", "-z", "--no-renames", "--name-only", assertId(from), assertId(to)]))
    },

    async restore(target, options) {
      assertId(target)
      if ((await text(["cat-file", "-t", target], { okCodes: [0, 128] })).trim() !== "tree") throw new SnapshotError(`${target} is not a snapshot in this workspace`)
      const pathspecs = (options.paths ?? []).map((path) => workspacePath(workspace, given, path))
      const takenAt = Date.now()
      const capture = await captureWorkspace()
      const scratch = `${capture.index}-target`
      try {
        if (!options.dryRun) await git(["update-ref", refName(options.session, takenAt), capture.id])
        const all = parseRaw(
          await text(["diff-tree", "-r", "-z", "--no-renames", capture.id, target, ...(pathspecs.includes("") ? [] : ["--", ...pathspecs])], {
            literalPathspecs: true,
          }),
        )
        const { changes, kept } = await excludeProtected(all, capture)
        const result = { before: capture.id, changes, kept }
        if (changes.length === 0) {
          await commitIndex(capture)
          return { kind: options.dryRun ? "dry_run" : "restored", ...result }
        }

        // The target state for the selected paths, on top of the current state, as a tree.
        const location = capture.location
        const current = (await text(["write-tree"], { indexFile: capture.index, workTree: location.workTree })).trim()
        await link(capture.index, scratch)
        const removals = changes.filter((change) => change.after === null).map((change) => `0 ${"0".repeat(change.before!.blob.length)}\t${location.prefix}${change.path}\0`)
        const updates = changes.flatMap((change) => (change.after === null ? [] : [`${MODES[change.after.kind]} ${change.after.blob}\t${location.prefix}${change.path}\0`]))
        await git(["update-index", "-z", "--index-info"], { indexFile: scratch, workTree: location.workTree, stdin: [...removals, ...updates].join("") })
        const desired = (await text(["write-tree"], { indexFile: scratch, workTree: location.workTree })).trim()

        // A two-tree fast-forward: git checks every path first and writes nothing if one is in the way,
        // removes only files the index tracks, refuses to write through a symlink, and prunes emptied directories.
        const merge = await git(["read-tree", "-m", "-u", ...(options.dryRun ? ["-n"] : []), current, desired], {
          indexFile: capture.index,
          workTree: location.workTree,
          okCodes: [0, 128],
        })
        if (merge.exitCode !== 0) return { kind: "blocked", ...result, message: merge.stderr.trim() }
        await commitIndex(capture)
        return { kind: options.dryRun ? "dry_run" : "restored", ...result }
      } finally {
        await rm(capture.index, { force: true })
        await rm(scratch, { force: true })
      }
    },

    list,

    async prune(options) {
      const refs = await list({ session: options.session })
      const now = options.now ?? Date.now()
      const protect = new Set<string>(typeof options.protect === "function" ? options.protect() : (options.protect ?? []))
      // Refs are newest first. A snapshot is kept through the newest ref that names it.
      const kept = new Set<string>()
      let counted = 0
      const removed = refs.filter((ref) => {
        const key = `${ref.session}\0${ref.id}`
        if (options.dedupe && kept.has(key)) return true
        if (!protect.has(ref.id)) {
          const position = counted
          counted += 1
          if ((options.keepLast !== undefined && position >= options.keepLast) || (options.olderThanMs !== undefined && now - ref.takenAt > options.olderThanMs)) return true
        }
        kept.add(key)
        return false
      })
      if (removed.length > 0) await deleteRefs(removed)
      const grace = options.graceSeconds ?? 3600
      const expire = `--prune=${grace <= 0 ? "now" : `${Math.ceil(grace)}.seconds.ago`}`
      // `--auto` must not leave a detached git behind: whoever called may be about to exit or remove the directory.
      const collected = await git(options.gc === "auto" ? ["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet", expire] : ["gc", "--quiet", expire], { okCodes: [0, 128] })
      // Another process is collecting this directory right now (sessions share it): its run does the work, and
      // what this prune unreferenced is collected by the next one.
      // (Git says so in two ways: it finds the other gc's lock, or it loses the race to write its own.)
      if (collected.exitCode !== 0 && !/gc is already running|gc\.pid\.lock/.test(collected.stderr))
        throw new SnapshotError(`git gc failed (exit ${collected.exitCode}): ${collected.stderr.trim().split("\n").slice(-3).join(" / ")}`, { exitCode: collected.exitCode, stderr: collected.stderr })
      await removeStaleIndexes()
      return { removed, remaining: refs.length - removed.length }
    },
  }

  /**
   * Deletes refs in one transaction. Another process of the same workspace
   * may hold the lock on the packed refs for a moment (its own prune, or
   * git's gc packing them), so a refusal for a lock is tried again a few times.
   */
  async function deleteRefs(refs: readonly SnapshotRef[]) {
    const stdin = refs.map((ref) => `delete ${ref.ref}\0\0`).join("")
    for (let attempt = 1; ; attempt += 1) {
      const result = await git(["update-ref", "--stdin", "-z"], { stdin, okCodes: [0, 128] })
      if (result.exitCode === 0) return
      const locked = /\.lock'|Unable to create|cannot lock ref/.test(result.stderr)
      if (!locked || attempt === 5) throw new SnapshotError(`git update-ref failed (exit ${result.exitCode}): ${result.stderr.trim().split("\n").slice(-3).join(" / ")}`, { exitCode: result.exitCode, stderr: result.stderr })
      await new Promise((resolve) => setTimeout(resolve, 40 * attempt))
    }
  }

  async function list(options: { readonly session?: string } = {}): Promise<SnapshotRef[]> {
    const base = options.session === undefined ? "refs/snapshots/" : `refs/snapshots/${sessionKey(options.session)}/`
    const lines = (await text(["for-each-ref", "--format=%(objectname) %(refname)", base])).split("\n").filter(Boolean)
    return lines
      .flatMap((line) => {
        const [id, ref] = line.split(" ") as [string, string]
        const match = /^refs\/snapshots\/([0-9a-f]+)\/(\d+)-/.exec(ref)
        if (!match) return []
        return [{ id: id as SnapshotId, session: Buffer.from(match[1]!, "hex").toString("utf8"), takenAt: Number(match[2]), ref }]
      })
      .sort((a, b) => b.takenAt - a.takenAt || (a.ref < b.ref ? 1 : -1))
  }

  /**
   * Records the workspace into a private copy of the shared index and writes
   * its tree. The copy is a hard link: git replaces an index by writing a new
   * file and renaming it, so the shared one is never changed underneath a
   * concurrent snapshot, and its stat data (and timestamp, which git's
   * racy-file check depends on) carry over exactly. Unchanged files are only
   * stat-ed, never read.
   */
  async function captureWorkspace(): Promise<Capture> {
    const location = await locate()
    const index = join(context.gitDir, `index.tmp-${process.pid}-${(counter += 1)}-${randomBytes(4).toString("hex")}`)
    const sameRoot = (await readFile(sharedIndexRoot, "utf8").catch(() => null)) === location.workTree
    if (sameRoot) await link(sharedIndex, index).catch(() => {})
    const run = { indexFile: index, workTree: location.workTree }
    try {
      const untracked = splitNul(await text(["ls-files", "-z", "--others", "--exclude-standard"], run))
      // ls-files does not descend into a directory holding a repository; it lists it with a trailing slash.
      const nested = untracked.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1))
      const skipped: SkippedFile[] = []
      for (const path of untracked) {
        if (path.endsWith("/")) continue
        const info = await lstat(join(workspace, path)).catch(() => null)
        if (info?.isFile() && info.size > maxFileBytes) skipped.push({ path, reason: "too_large", bytes: info.size })
      }
      const pathspecs = [".", ...nested.map((path) => `:(exclude,literal)${path}/`), ...skipped.map((file) => `:(exclude,literal)${file.path}`)]
      const unreadable = await addAll(pathspecs, run, location)
      if (unreadable.length > 0) {
        // A tracked file that became unreadable would otherwise keep its old content in the snapshot.
        const files = unreadable.filter((path) => !path.endsWith("/"))
        if (files.length > 0)
          await git(["update-index", "-z", "--force-remove", "--stdin"], { ...run, cwd: location.workTree, stdin: files.map((path) => `${location.prefix}${path}\0`).join("") })
        skipped.push(...unreadable.map((path) => ({ path, reason: "unreadable" as const })))
      }
      return { id: await writeTree(location, index), location, index, skipped, nested }
    } catch (error) {
      await rm(index, { force: true })
      throw error
    }
  }

  /** `git add -A` with exclusions. Retries once: a file deleted between listing and hashing is fatal to `git add`. Returns unreadable paths. */
  async function addAll(pathspecs: string[], run: Partial<RunOptions>, location: Location): Promise<string[]> {
    const args = ["add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"]
    const stdin = `${pathspecs.join("\0")}\0`
    let result = await git(args, { ...run, stdin, okCodes: [0, 1, 128] })
    if (result.exitCode === 128) result = await git(args, { ...run, stdin, okCodes: [0, 1] })
    const fromRoot = (path: string) => (path.startsWith(location.prefix) ? path.slice(location.prefix.length) : path)
    const files = [...result.stderr.matchAll(/^error: unable to index file '(.*)'$/gm)].map((match) => fromRoot(match[1]!))
    const dirs = [...result.stderr.matchAll(/^warning: could not open directory '(.*)': /gm)].map((match) => fromRoot(match[1]!))
    if (result.exitCode !== 0 && files.length === 0) throw new SnapshotError(`git add failed: ${result.stderr.trim()}`, { args, exitCode: result.exitCode, stderr: result.stderr })
    return [...new Set([...files, ...dirs])]
  }

  async function writeTree(location: Location, index: string): Promise<SnapshotId> {
    const run = { indexFile: index, workTree: location.workTree }
    if (location.prefix === "") return (await text(["write-tree"], run)).trim() as SnapshotId
    const result = await git(["write-tree", `--prefix=${location.prefix}`], { ...run, okCodes: [0, 128] })
    if (result.exitCode === 0) return new TextDecoder().decode(result.stdout).trim() as SnapshotId
    // Nothing captured under the prefix: the workspace is empty.
    return (await text(["mktree"], { stdin: "" })).trim() as SnapshotId
  }

  /** The repository root above the workspace, when the workspace is in one and not ignored by it; else the workspace. */
  async function locate(): Promise<Location> {
    for (let dir = workspace; ; dir = dirname(dir)) {
      if (await exists(join(dir, ".git"))) {
        if (dir === workspace) break
        const prefix = `${relative(dir, workspace).split(sep).join("/")}/`
        // A workspace that the enclosing repository ignores (a scratch directory, or a home directory repo ignoring `*`)
        // would capture nothing under that repository's rules, so it stands alone.
        const ignored = await git(["check-ignore", "-q", "--no-index", prefix.slice(0, -1)], {
          cwd: dir,
          workTree: dir,
          indexFile: join(context.gitDir, "index-none"),
          okCodes: [0, 1],
        })
        if (ignored.exitCode === 0) break
        return { workTree: dir, prefix }
      }
      if (dirname(dir) === dir) break
    }
    return { workTree: workspace, prefix: "" }
  }

  /**
   * Leaves out what restore must not touch: anything inside a nested
   * repository; a path the target has but the current snapshot does not, where
   * something uncaptured (an ignored or oversized file, a directory) is in the
   * way, since git would overwrite an ignored file and it could not be undone;
   * and deletions of files that are ignored now.
   */
  async function excludeProtected(changes: FileChange[], capture: Capture) {
    const kept: KeptPath[] = []
    const deleted = new Set(changes.filter((change) => change.after === null).map((change) => change.path))
    const allowed: FileChange[] = []
    for (const change of changes) {
      if (capture.nested.some((dir) => change.path === dir || change.path.startsWith(`${dir}/`))) kept.push({ path: change.path, reason: "nested_repository" })
      else if (change.before === null && (await inTheWay(change.path, deleted))) kept.push({ path: change.path, reason: "not_captured" })
      else allowed.push(change)
    }
    const deletions = allowed.filter((change) => change.after === null).map((change) => change.path)
    if (deletions.length === 0) return { changes: allowed, kept }
    const result = await git(["check-ignore", "--no-index", "-z", "--stdin"], {
      workTree: capture.location.workTree,
      indexFile: capture.index,
      stdin: `${deletions.join("\0")}\0`,
      okCodes: [0, 1],
    })
    const ignored = new Set(splitNul(new TextDecoder().decode(result.stdout)))
    for (const path of ignored) kept.push({ path, reason: "ignored" })
    return { changes: allowed.filter((change) => !(change.after === null && ignored.has(change.path))), kept }
  }

  /** Makes a capture's index the shared stat cache. Concurrent snapshots each write a complete index; the last rename wins. */
  async function commitIndex(capture: Capture) {
    await writeFile(sharedIndexRoot, capture.location.workTree)
    await rename(capture.index, sharedIndex).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }

  /**
   * Something uncaptured occupies `path`: a file or link, a directory holding anything restore is not deleting,
   * or a parent that is a non-directory restore is not deleting.
   */
  async function inTheWay(path: string, deleted: Set<string>) {
    // Parents first: lstat of the path itself would follow a symlinked parent out of the workspace.
    const parts = path.split("/")
    for (let end = 1; end < parts.length; end += 1) {
      const parent = parts.slice(0, end).join("/")
      const info = await lstat(join(workspace, parent)).catch(() => null)
      if (info === null) return false
      if (!info.isDirectory()) return !deleted.has(parent)
    }
    const info = await lstat(join(workspace, path)).catch(() => null)
    if (info === null) return false
    if (!info.isDirectory()) return true
    const entries = await readdir(join(workspace, path), { recursive: true, withFileTypes: true })
    return entries.some((entry) => !entry.isDirectory() && !deleted.has(relative(workspace, join(entry.parentPath, entry.name)).split(sep).join("/")))
  }

  async function removeStaleIndexes() {
    const cutoff = Date.now() - 3600_000
    for (const name of await readdir(context.gitDir)) {
      if (!name.startsWith("index.tmp-")) continue
      const info = await stat(join(context.gitDir, name)).catch(() => null)
      if (info && info.mtimeMs < cutoff) await rm(join(context.gitDir, name), { force: true, recursive: true })
    }
  }
}

function refName(session: string, takenAt: number) {
  return `refs/snapshots/${sessionKey(session)}/${String(takenAt).padStart(13, "0")}-${process.pid}-${(counter += 1)}-${randomBytes(3).toString("hex")}`
}

function sessionKey(session: string) {
  if (session === "") throw new SnapshotError("session must not be empty")
  return Buffer.from(session, "utf8").toString("hex")
}

function assertId(id: SnapshotId): SnapshotId {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)) throw new SnapshotError(`not a snapshot id: ${JSON.stringify(id)}`)
  return id
}

/** A path relative to the workspace (`""` for all of it), `/`-separated. Absolute paths must be inside the workspace. */
function workspacePath(workspace: string, given: string, input: string) {
  const inside = (base: string) => {
    const rel = relative(base, isAbsolute(input) ? input : join(base, input))
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel.split(sep).join("/")
  }
  const rel = inside(workspace) ?? (isAbsolute(input) ? inside(given) : null)
  if (rel === null) throw new SnapshotError(`path is outside the workspace: ${input}`)
  return rel
}

function splitNul(output: string) {
  return output.split("\0").filter((part) => part !== "")
}

async function exists(path: string) {
  return (await lstat(path).catch(() => null)) !== null
}
