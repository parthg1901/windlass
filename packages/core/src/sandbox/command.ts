/**
 * The sandbox as the shell tool and the check runner use it: the policy of a
 * command that runs in a session's working directory, and the session's temp
 * directory. `policy.ts` and the backends know nothing about sessions, git or
 * the harness's project directory; this file adds exactly that.
 *
 * What a sandboxed command gets on top of `defaultPolicy`:
 *
 * - The session's temp directory as its temp root: `/tmp` on Linux, `TMPDIR`
 *   on macOS. It outlives the command, so a file one command leaves there is
 *   there for the next, and it is the session's own (mode 0700, one per
 *   session), so nothing else on the machine is in it.
 * - The repository's git directory writable when it is not inside the working
 *   directory (a session in a subdirectory of a repository, a linked
 *   worktree): `git add` and `git commit` write there.
 * - `hooks` and `config` of that git directory, and the harness's project
 *   directory, read-only: a command may otherwise plant a hook, an alias or a
 *   check that runs later outside the sandbox. This is what breaks: anything
 *   that writes the repository's configuration or hooks (`git config`,
 *   `git remote add`, `git branch --set-upstream-to`, `git submodule init`,
 *   a package manager's hook installer such as husky). No access the user
 *   grants opens them; `sandboxHint` tells the model so when one is refused.
 * - With the network granted, Bun's install cache in the temp directory: a
 *   download needs a writable cache, and the user's own cache is what later
 *   installs outside the sandbox trust, so it stays read-only.
 *
 * Nothing else was needed for `bun test`, `bun run`, an offline `bun install`
 * from the lockfile, `tsc` and local git commits: they read the user's Bun
 * cache and git configuration, which the default policy leaves readable.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { brand } from "../brand.ts"
import type { SandboxRun, TempDirectory } from "../tool/tool.ts"
import { type SandboxDetection, detectSandbox } from "./detect.ts"
import { type SandboxPlan, type SandboxUnavailable, sandboxCommand } from "./index.ts"
import { type SandboxPolicy, defaultPolicy } from "./policy.ts"

export interface CommandSandboxOptions {
  /** Where the sessions' temp directories are made. Default: `<os temp>/<brand.directory>-<uid>`. */
  readonly tempBase?: string
  /** The environment commands inherit from, before the policy filters it. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Instead of `detectSandbox()`. */
  readonly detection?: SandboxDetection
  readonly home?: string
}

export interface CommandInput {
  readonly sessionId: string
  /** The session's working directory: the workspace. */
  readonly cwd: string
  readonly run: SandboxRun
  readonly command: string
  readonly shellPath?: string
}

export interface CommandSandbox {
  /** Whether commands can be sandboxed on this machine, and if not, why and what would fix it. */
  readonly state: { readonly available: true } | { readonly available: false; readonly reason: string; readonly remedy: string | null }
  /** The session's temp directory, created on first use. `alias` is where sandboxed commands see it. */
  readonly temp: (sessionId: string) => TempDirectory
  /** What to spawn for a command, or why it cannot be sandboxed. Never a plan that runs it unsandboxed. */
  readonly plan: (input: CommandInput) => SandboxPlan | SandboxUnavailable
  /** The policy `plan` applies, for a test or a person to look at. */
  readonly policy: (input: Pick<CommandInput, "sessionId" | "cwd" | "run">) => SandboxPolicy
}

export function createCommandSandbox(options: CommandSandboxOptions = {}): CommandSandbox {
  const detection = options.detection ?? detectSandbox()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const temps = new Map<string, string>()
  let base: string | null = null

  const temp = (sessionId: string): TempDirectory => {
    let dir = temps.get(sessionId)
    if (dir === undefined) {
      base ??= privateDirectory(options.tempBase ?? join(tmpdir(), `${brand.directory}-${process.getuid?.() ?? 0}`))
      dir = join(base, sessionId.replace(/[^A-Za-z0-9_.-]/g, "_"))
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      temps.set(sessionId, dir)
    }
    // Under bubblewrap the directory is mounted at /tmp; sandbox-exec leaves paths as they are.
    return { dir, alias: detection.available && detection.backend === "bwrap" ? "/tmp" : null }
  }
  const policy = (input: Pick<CommandInput, "sessionId" | "cwd" | "run">) => workspacePolicy({ cwd: input.cwd, tempRoot: temp(input.sessionId).dir, run: input.run, home, env })

  return {
    state: detection.available ? { available: true } : { available: false, reason: detection.reason, remedy: detection.remedy },
    temp,
    policy,
    plan: (input) => {
      const plan = sandboxCommand(policy(input), { shell: input.command, cwd: input.cwd, ...(input.shellPath === undefined ? {} : { shellPath: input.shellPath }) }, { env, detection })
      if (plan.kind !== "ready" || !input.run.network) return plan
      // A download needs a cache it can write. The user's own stays read-only: what is in it runs outside the sandbox later.
      return { ...plan, env: { ...plan.env, BUN_INSTALL_CACHE_DIR: join(plan.env.TMPDIR ?? "/tmp", ".bun-install-cache") } }
    },
  }
}

/** The policy of a command in `cwd`: the default one, with the session's temp directory, the access the decision granted, and the git hardening. */
export function workspacePolicy(input: {
  readonly cwd: string
  readonly tempRoot: string
  readonly run: SandboxRun
  readonly home?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): SandboxPolicy {
  const base = defaultPolicy({
    workspace: input.cwd,
    tempRoot: input.tempRoot,
    network: { mode: input.run.network ? "on" : "off" },
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.env === undefined ? {} : { env: input.env }),
  })
  const git = gitLayout(input.cwd)
  const outside = git === null ? [] : [...new Set([git.gitDir, git.commonDir])].filter((path) => !within(input.cwd, path))
  return {
    ...base,
    writableRoots: [...new Set([...base.writableRoots, ...input.run.writableRoots, ...outside])],
    readOnlyPaths: [...(git === null ? [] : gitProtected(git)), join(input.cwd, `.${brand.directory}`)],
  }
}

export interface GitLayout {
  /** The directory `.git` is, or points to (a linked worktree's own directory under the main repository's). */
  readonly gitDir: string
  /** Where objects, refs, hooks and the configuration are: `gitDir`, or the main repository's for a worktree. */
  readonly commonDir: string
}

/** The git directory of the repository `cwd` is in, found the way git finds it: `.git` here or in the nearest parent. */
export function gitLayout(cwd: string): GitLayout | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const entry = join(dir, ".git")
    const info = statOrNull(entry)
    if (info?.isDirectory()) return { gitDir: entry, commonDir: entry }
    if (info?.isFile()) {
      // A worktree or a submodule: `.git` is a file naming the real directory.
      const named = /^gitdir:\s*(.+)$/m.exec(readOrNull(entry) ?? "")?.[1]?.trim()
      if (named === undefined) return null
      const gitDir = isAbsolute(named) ? named : resolve(dir, named)
      const common = readOrNull(join(gitDir, "commondir"))?.trim()
      return { gitDir, commonDir: common === undefined || common === "" ? gitDir : isAbsolute(common) ? common : resolve(gitDir, common) }
    }
    if (dirname(dir) === dir) return null
  }
}

/** What stays read-only in a repository's git directory. The hooks directory is created when it is missing, so that it can be. */
function gitProtected(git: GitLayout): string[] {
  const hooks = join(git.commonDir, "hooks")
  try {
    mkdirSync(hooks)
  } catch {
    // It exists (the usual case), or the directory cannot be written: nothing to protect that is not protected already.
  }
  return [...new Set([hooks, join(git.commonDir, "config"), join(git.gitDir, "config"), join(git.gitDir, "config.worktree"), join(git.gitDir, "hooks")])]
}

/** `path` as a directory only this user can enter: made if missing, replaced by a fresh one when it is someone else's or open to others. */
function privateDirectory(path: string): string {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const info = lstatSync(path)
    const uid = process.getuid?.()
    if (info.isDirectory() && (uid === undefined || info.uid === uid)) {
      if ((info.mode & 0o077) !== 0) chmodSync(path, 0o700)
      return path
    }
  } catch {
    // Fall through to a directory of our own.
  }
  return mkdtempSync(join(tmpdir(), `${brand.directory}-`))
}

function within(root: string, path: string) {
  return path === root || path.startsWith(`${root}/`)
}

function statOrNull(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function readOrNull(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}
