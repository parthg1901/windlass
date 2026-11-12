/**
 * A git worktree for a subagent that must not edit the files its parent (or
 * its siblings) are editing, and the merge of what it did back into the
 * parent's workspace.
 *
 * What is done to the user's repository, and what is not:
 *
 * - The worktree starts from the parent's workspace as it is now, uncommitted
 *   changes and untracked files included (not ignored ones): that state is
 *   written as one commit on a new branch, built with a private index, so
 *   the user's index, branches, HEAD and stash are not touched. The branch
 *   (`<binary>/subagent-<id>`) and the worktree directory (outside the
 *   repository) are the harness's own.
 * - The merge back changes files in the parent's working directory and
 *   nothing else: no commit, no index change, no branch moved. Every file the
 *   child changed is merged three ways (the branch's start, the child's
 *   result, the file as it is now in the parent's workspace). All results are
 *   computed first; if one file conflicts nothing is written, the branch is
 *   kept, and the conflict is reported with what to do. So the workspace is
 *   either merged or exactly as it was, never half merged.
 * - No hook of the repository runs for any of it (`core.hooksPath` is
 *   overridden per command), and nothing is signed or pushed.
 * - When the work is merged, or had nothing to merge, the worktree and the
 *   branch are removed. After a conflict or a failure the worktree is removed
 *   and the branch stays, with the child's work committed on it.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { brand } from "../brand.ts"
import type { WorktreeRecord } from "../event/durable.ts"

export interface GitResult {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

/** Runs the user's git in `cwd` with no hooks, no prompts, no signing and the harness as the author of what it commits. */
export async function git(cwd: string, args: readonly string[], options: { readonly env?: Record<string, string>; readonly stdin?: Uint8Array } = {}): Promise<GitResult> {
  const hardening = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", `user.name=${brand.name}`, "-c", "user.email=subagent@localhost", "-c", "core.quotePath=false", "-c", "gc.auto=0"]
  try {
    const child = Bun.spawn(["git", ...hardening, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...options.env },
      stdin: options.stdin === undefined ? "ignore" : options.stdin,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited])
    return { code, stdout: new Uint8Array(stdout), stderr }
  } catch (error) {
    return { code: 127, stdout: new Uint8Array(), stderr: error instanceof Error ? error.message : String(error) }
  }
}

const text = (result: GitResult) => new TextDecoder().decode(result.stdout).trim()
const lastLine = (result: GitResult) => result.stderr.trim().split("\n").at(-1) ?? `git exited with ${result.code}`

/** The branch a subagent's worktree is on. */
export function worktreeBranch(childId: string): string {
  return `${brand.binary}/subagent-${childId.replace(/[^A-Za-z0-9_-]/g, "").slice(-12)}`
}

/**
 * Creates the worktree at `directory` on a new branch that starts from the
 * workspace as it stands. Returns the record, with `path` the directory in
 * the worktree that corresponds to `cwd`, or why there is none.
 */
export async function createWorktree(input: { readonly cwd: string; readonly directory: string; readonly branch: string }): Promise<{ readonly worktree: WorktreeRecord; readonly cwd: string } | { readonly error: string }> {
  const top = await git(input.cwd, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) return { error: "the working directory is not in a git repository, so a subagent cannot get a worktree of its own. Run it without `worktree`: it then shares this workspace." }
  const repository = text(top)
  const head = await git(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
  if (head.code !== 0) return { error: "the repository has no commit yet, so there is nothing a worktree could start from. Run the subagent without `worktree`." }
  // The workspace as it is now, as a tree, through an index of our own: the user's index is only copied, never written.
  const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-worktree-`))
  try {
    const index = join(scratch, "index")
    const own = text(await git(repository, ["rev-parse", "--git-path", "index"]))
    const source = resolve(repository, own)
    if (existsSync(source)) writeFileSync(index, readFileSync(source))
    const env = { GIT_INDEX_FILE: index }
    const added = await git(repository, ["add", "-A", "--ignore-errors", "."], { env })
    if (added.code !== 0 && added.code !== 1) return { error: `the workspace could not be recorded for the worktree: ${lastLine(added)}` }
    const tree = await git(repository, ["write-tree"], { env })
    if (tree.code !== 0) return { error: `the workspace could not be recorded for the worktree: ${lastLine(tree)}` }
    const same = text(await git(repository, ["rev-parse", "HEAD^{tree}"])) === text(tree)
    const base = same ? head : await git(repository, ["commit-tree", text(tree), "-p", text(head), "-m", `${brand.name}: the workspace a subagent started from`])
    if (base.code !== 0) return { error: `the workspace could not be recorded for the worktree: ${lastLine(base)}` }
    mkdirSync(dirname(input.directory), { recursive: true })
    const made = await git(repository, ["worktree", "add", "--quiet", "-b", input.branch, input.directory, text(base)])
    if (made.code !== 0) return { error: `git could not create the worktree: ${lastLine(made)}` }
    const inside = relative(repository, await realPath(input.cwd))
    return {
      worktree: { path: input.directory, branch: input.branch, base: text(base), repository },
      cwd: inside === "" || inside.startsWith("..") ? input.directory : join(input.directory, inside),
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path).catch(() => resolve(path))
}

export interface MergeOutcome {
  /** `merged`: the files were written. `conflicts`: nothing was written. `nothing`: the child changed no file. `failed`: git failed; nothing was written. */
  readonly status: "merged" | "conflicts" | "nothing" | "failed"
  readonly branch: string
  /** The commit the child's work is on, when there is one. */
  readonly commit: string | null
  /** Every file the child changed, relative to the repository. */
  readonly files: readonly string[]
  readonly conflicts: readonly string[]
  /** Whether the branch still exists: after a conflict or a failure, so the work is not lost. */
  readonly kept: boolean
  /** One or two sentences for the model: what happened and what it can do. */
  readonly message: string
}

/** Commits whatever the worktree holds onto its branch. Returns the tip, or `null` with the reason. */
async function commitWork(worktree: WorktreeRecord, message: string): Promise<{ readonly tip: string } | { readonly error: string }> {
  if (!existsSync(worktree.path)) {
    const tip = await git(worktree.repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`])
    return tip.code === 0 ? { tip: text(tip) } : { error: `the worktree ${worktree.path} and its branch are gone` }
  }
  const added = await git(worktree.path, ["add", "-A", "."])
  if (added.code !== 0) return { error: lastLine(added) }
  const staged = await git(worktree.path, ["diff", "--cached", "--quiet"])
  if (staged.code === 1) {
    const committed = await git(worktree.path, ["commit", "--quiet", "--no-verify", "-m", message])
    if (committed.code !== 0) return { error: lastLine(committed) }
  }
  const tip = await git(worktree.path, ["rev-parse", "HEAD"])
  return tip.code === 0 ? { tip: text(tip) } : { error: lastLine(tip) }
}

/** Removes the worktree directory and, unless it is kept, its branch. Never throws: what cannot be removed is left. */
export async function removeWorktree(worktree: WorktreeRecord, options: { readonly keepBranch: boolean }): Promise<void> {
  if (existsSync(worktree.path)) {
    const removed = await git(worktree.repository, ["worktree", "remove", "--force", worktree.path])
    if (removed.code !== 0) rmSync(worktree.path, { recursive: true, force: true })
  }
  await git(worktree.repository, ["worktree", "prune"])
  if (!options.keepBranch) await git(worktree.repository, ["branch", "-D", "--quiet", worktree.branch])
}

/**
 * For a subagent that will not finish (it was lost to a restart, or
 * stopped): what it had done is committed onto its branch, the worktree is
 * removed, and the branch is kept when it holds work, so nothing is lost and
 * nothing is merged.
 */
export async function salvageWorktree(worktree: WorktreeRecord, title: string): Promise<MergeOutcome> {
  const work = await commitWork(worktree, `${brand.name} subagent (unfinished): ${title}`)
  const tip = "tip" in work ? work.tip : null
  const holdsWork = tip !== null && tip !== worktree.base
  await removeWorktree(worktree, { keepBranch: holdsWork })
  return {
    status: "nothing",
    branch: worktree.branch,
    commit: holdsWork ? tip : null,
    files: [],
    conflicts: [],
    kept: holdsWork,
    message: holdsWork ? `What it had done so far is on branch ${worktree.branch} (commit ${tip!.slice(0, 12)}); nothing was merged into this workspace.` : "It had changed no file.",
  }
}

interface FileVersion {
  readonly bytes: Uint8Array
  /** `100644`, `100755` or `120000`. */
  readonly mode: string
}

async function versionAt(repository: string, commit: string, path: string): Promise<FileVersion | null> {
  const entry = text(await git(repository, ["ls-tree", "-z", commit, "--", path]))
  const match = /^(\d{6}) blob ([0-9a-f]+)\t/.exec(entry)
  if (match === null) return null
  const blob = await git(repository, ["cat-file", "blob", match[2]!])
  return blob.code === 0 ? { bytes: blob.stdout, mode: match[1]! } : null
}

function versionOnDisk(path: string): FileVersion | null {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return { bytes: new TextEncoder().encode(readlinkSync(path)), mode: "120000" }
    if (!info.isFile()) return null
    return { bytes: readFileSync(path), mode: (info.mode & 0o111) !== 0 ? "100755" : "100644" }
  } catch {
    return null
  }
}

const same = (a: FileVersion | null, b: FileVersion | null) =>
  a === null || b === null ? a === b : a.mode === b.mode && a.bytes.length === b.bytes.length && Buffer.compare(a.bytes, b.bytes) === 0

/**
 * Merges the child's work into the parent's workspace and cleans up. `probe`
 * is called between computing the merge and writing the first file (a crash
 * test dies there, and after the first file).
 */
export async function mergeWorktree(worktree: WorktreeRecord, input: { readonly title: string; readonly probe?: (point: "computed" | "writing") => void }): Promise<MergeOutcome> {
  const base = { branch: worktree.branch, files: [] as string[], conflicts: [] as string[] }
  const failed = async (reason: string): Promise<MergeOutcome> => {
    await removeWorktree(worktree, { keepBranch: true })
    return { ...base, status: "failed", commit: null, kept: true, message: `Its work could not be merged into this workspace (${reason}); nothing was changed here. It is on branch ${worktree.branch}.` }
  }
  const work = await commitWork(worktree, `${brand.name} subagent: ${input.title}`)
  if ("error" in work) return failed(work.error)
  const tip = work.tip
  if (tip === worktree.base) {
    await removeWorktree(worktree, { keepBranch: false })
    return { ...base, status: "nothing", commit: null, kept: false, message: "It changed no file, so there was nothing to merge." }
  }
  const listed = await git(worktree.repository, ["diff", "--name-only", "-z", "--no-renames", worktree.base, tip])
  if (listed.code !== 0) return failed(lastLine(listed))
  const files = new TextDecoder().decode(listed.stdout).split("\0").filter((path) => path !== "")
  const writes: { readonly path: string; readonly result: FileVersion | null }[] = []
  const conflicts: string[] = []
  const scratch = mkdtempSync(join(tmpdir(), `${brand.directory}-merge-`))
  try {
    for (const path of files) {
      const [origin, theirs] = await Promise.all([versionAt(worktree.repository, worktree.base, path), versionAt(worktree.repository, tip, path)])
      const ours = versionOnDisk(join(worktree.repository, path))
      if (same(ours, theirs)) continue
      // The parent did not touch it since the branch started: the child's version is the result.
      if (same(ours, origin)) {
        writes.push({ path, result: theirs })
        continue
      }
      // Both changed it. Text merges line by line; a deletion on one side, a link, or a file with no common start does not.
      if (ours === null || theirs === null || origin === null || [ours, theirs, origin].some((version) => version.mode === "120000")) {
        conflicts.push(path)
        continue
      }
      const names = ["ours", "base", "theirs"].map((name) => join(scratch, name))
      ;[ours, origin, theirs].forEach((version, index) => writeFileSync(names[index]!, version.bytes))
      const merged = await git(scratch, ["merge-file", "-p", names[0]!, names[1]!, names[2]!])
      if (merged.code !== 0) conflicts.push(path)
      else writes.push({ path, result: { bytes: merged.stdout, mode: theirs.mode === origin.mode ? ours.mode : theirs.mode } })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (conflicts.length > 0) {
    await removeWorktree(worktree, { keepBranch: true })
    return {
      ...base,
      status: "conflicts",
      commit: tip,
      files,
      conflicts,
      kept: true,
      message: `Its work was NOT merged: ${conflicts.length === 1 ? `${conflicts[0]} was` : `${conflicts.length} files were`} also changed in this workspace since it started, and the changes conflict (${conflicts.join(", ")}). Nothing was changed here. Its work is commit ${tip.slice(0, 12)} on branch ${worktree.branch}: look at it with \`git diff ${worktree.base.slice(0, 12)} ${tip.slice(0, 12)} -- <file>\` and apply what is needed by hand.`,
    }
  }
  input.probe?.("computed")
  let first = true
  for (const { path, result } of writes) {
    const target = join(worktree.repository, path)
    if (result === null) rmSync(target, { force: true })
    else {
      mkdirSync(dirname(target), { recursive: true })
      rmSync(target, { force: true })
      if (result.mode === "120000") symlinkSync(new TextDecoder().decode(result.bytes), target)
      else {
        writeFileSync(target, result.bytes)
        chmodSync(target, result.mode === "100755" ? 0o755 : 0o644)
      }
    }
    if (first) input.probe?.("writing")
    first = false
  }
  await removeWorktree(worktree, { keepBranch: false })
  return {
    ...base,
    status: "merged",
    commit: tip,
    files,
    kept: false,
    message: `Its changes to ${files.length} file${files.length === 1 ? "" : "s"} were merged into this workspace (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", ..." : ""}); nothing was committed.`,
  }
}
