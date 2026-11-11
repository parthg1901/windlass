/**
 * Running `git` against the private snapshot repository, isolated from
 * everything the user (or a hostile workspace) can configure.
 *
 * Isolation, layer by layer:
 * - The environment is built from scratch. Nothing is inherited except PATH
 *   and TMPDIR, so a GIT_DIR, GIT_INDEX_FILE or GIT_CONFIG_* set by a parent
 *   process (a git hook running the harness, say) cannot redirect a command.
 * - GIT_DIR is always the private directory, so git never discovers or reads
 *   the workspace's own `.git`: not its config, hooks, index or refs.
 * - System and global config are off (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL,
 *   and HOME / XDG_CONFIG_HOME pointing at the private directory, for git
 *   older than 2.32), as are the system attributes file and `core.attributesFile`.
 * - `COMMAND_CONFIG` is passed with `-c` on every call. Command-line config
 *   wins over any file, and git passes it on to the git processes it starts
 *   (gc runs repack and prune).
 * - `info/attributes` in the private directory (highest precedence) resets
 *   every attribute that can change bytes or pick a driver, so a workspace
 *   `.gitattributes` cannot name a filter or diff driver, convert line
 *   endings, expand `$Id$` or re-encode text. No driver is defined anywhere
 *   git looks, so there is nothing for one to name in any case.
 */
import { brand } from "../brand.ts"

/** Oldest git with `--pathspec-from-file` (2.25). */
const MIN_VERSION = [2, 25] as const

export const COMMAND_CONFIG: Record<string, string> = {
  "core.fsmonitor": "false",
  "core.hooksPath": "/dev/null",
  "core.excludesFile": "/dev/null",
  "core.attributesFile": "/dev/null",
  "core.autocrlf": "false",
  "core.safecrlf": "false",
  "core.symlinks": "true",
  "core.fileMode": "true",
  "core.quotePath": "false",
  "core.untrackedCache": "true",
  "core.preloadIndex": "true",
  "core.logAllRefUpdates": "false",
  "core.sparseCheckout": "false",
  "core.splitIndex": "false",
  "core.sshCommand": "false",
  "credential.helper": "",
  "protocol.allow": "never",
  "submodule.recurse": "false",
  "diff.external": "",
  "gc.auto": "0",
  "maintenance.auto": "false",
  "advice.detachedHead": "false",
}

/** Written to `info/attributes`; `!attr` makes an attribute unspecified whatever a `.gitattributes` says. */
export const ATTRIBUTE_OVERRIDES = "* !text !eol !crlf !ident !filter !working-tree-encoding !diff !merge !export-subst\n"

export type GitResult = {
  readonly exitCode: number
  readonly stdout: Uint8Array
  readonly stderr: string
  /** stdout was cut at `maxStdout` and the process was killed. */
  readonly truncated: boolean
}

export class SnapshotError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly args?: readonly string[]; readonly exitCode?: number; readonly stderr?: string } = {},
  ) {
    super(message)
    this.name = "SnapshotError"
  }
}

export interface GitContext {
  readonly git: string
  readonly gitDir: string
  /** Inherited PATH and TMPDIR (macOS keeps its temp directory there). */
  readonly baseEnv: Record<string, string>
}

export interface RunOptions {
  readonly cwd: string
  readonly workTree?: string
  readonly indexFile?: string
  readonly stdin?: string | Uint8Array
  /** Read at most this many bytes of stdout, then stop the process. */
  readonly maxStdout?: number
  /** Treat every pathspec literally (no globs, no magic). */
  readonly literalPathspecs?: boolean
  /** Exit codes that are not failures. Default [0]. */
  readonly okCodes?: readonly number[]
}

export function gitEnv(context: GitContext, options: Pick<RunOptions, "workTree" | "indexFile" | "literalPathspecs">): Record<string, string> {
  return {
    ...context.baseEnv,
    HOME: context.gitDir,
    XDG_CONFIG_HOME: context.gitDir,
    LC_ALL: "C",
    LANG: "C",
    GIT_DIR: context.gitDir,
    ...(options.workTree === undefined ? {} : { GIT_WORK_TREE: options.workTree }),
    ...(options.indexFile === undefined ? {} : { GIT_INDEX_FILE: options.indexFile }),
    ...(options.literalPathspecs ? { GIT_LITERAL_PATHSPECS: "1" } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_AUTHOR_NAME: brand.name,
    GIT_AUTHOR_EMAIL: "snapshot@localhost",
    GIT_COMMITTER_NAME: brand.name,
    GIT_COMMITTER_EMAIL: "snapshot@localhost",
  }
}

const configArgs = Object.entries(COMMAND_CONFIG).flatMap(([key, value]) => ["-c", `${key}=${value}`])

export async function runGit(context: GitContext, args: readonly string[], options: RunOptions): Promise<GitResult> {
  const argv = [context.git, ...configArgs, ...args]
  let child: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">
  try {
    child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: gitEnv(context, options),
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
  } catch (error) {
    throw new SnapshotError(`could not run git: ${error instanceof Error ? error.message : String(error)}`, { args })
  }
  if (options.stdin !== undefined && child.stdin) {
    const sink = child.stdin as Bun.FileSink
    sink.write(options.stdin)
    await sink.end()
  }
  const stderrPromise = new Response(child.stderr).text()
  const { bytes, truncated } = await readCapped(child.stdout, options.maxStdout ?? Number.POSITIVE_INFINITY, () => child.kill("SIGKILL"))
  const exitCode = await child.exited
  const stderr = await stderrPromise
  if (!truncated && !(options.okCodes ?? [0]).includes(exitCode))
    throw new SnapshotError(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim().split("\n").slice(-3).join(" / ")}`, { args, exitCode, stderr })
  return { exitCode, stdout: bytes, stderr, truncated }
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number, stop: () => void) {
  const chunks: Uint8Array[] = []
  let length = 0
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    chunks.push(next.value)
    length += next.value.length
    if (length > max) {
      stop()
      await reader.cancel().catch(() => {})
      return { bytes: concat(chunks).subarray(0, max), truncated: true }
    }
  }
  return { bytes: concat(chunks), truncated: false }
}

function concat(chunks: Uint8Array[]) {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export type GitProbe =
  | { readonly kind: "ok"; readonly git: string; readonly version: string }
  | { readonly kind: "unavailable"; readonly reason: "git_not_found" | "git_too_old"; readonly message: string }

/** Finds git and checks its version. Never throws. */
export function probeGit(gitPath: string | undefined, baseEnv: Record<string, string>): GitProbe {
  const git = gitPath ?? Bun.which("git", { PATH: baseEnv.PATH ?? "" })
  if (!git) return { kind: "unavailable", reason: "git_not_found", message: "git was not found on PATH; snapshots need git 2.25 or newer." }
  let output: string
  try {
    const result = Bun.spawnSync([git, "--version"], { env: { ...baseEnv, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) return { kind: "unavailable", reason: "git_not_found", message: `\`${git} --version\` exited with ${result.exitCode}.` }
    output = result.stdout.toString().trim()
  } catch (error) {
    return { kind: "unavailable", reason: "git_not_found", message: `could not run ${git}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const match = /git version (\d+)\.(\d+)/.exec(output)
  if (!match) return { kind: "unavailable", reason: "git_not_found", message: `unrecognised \`git --version\` output: ${output}` }
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1]))
    return { kind: "unavailable", reason: "git_too_old", message: `${output} is too old; snapshots need git ${MIN_VERSION.join(".")} or newer.` }
  return { kind: "ok", git, version: output }
}
