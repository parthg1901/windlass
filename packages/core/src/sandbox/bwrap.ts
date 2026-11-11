/**
 * Linux backend: bubblewrap. The command runs in new user, pid, ipc, uts and
 * cgroup namespaces (plus net when the network is off) on a read-only view of
 * the host, with the writable roots bound back read-write, a private /tmp, a
 * fresh /proc (only the sandbox's own processes) and a minimal /dev.
 *
 * Process lifetime:
 * - No `--new-session`: every sandboxed process stays in the caller's process
 *   group, so `kill(-pgid)` reaches all of them. The caller spawns detached
 *   (setsid), which also leaves the sandbox without a controlling terminal, so
 *   TIOCSTI injection (the reason `--new-session` exists) has no target.
 * - `--die-with-parent` and the pid namespace: when bwrap or its parent dies,
 *   or the command (pid 2 under bwrap's init) exits, the kernel SIGKILLs every
 *   process left in the namespace, including ones that called setsid.
 * - bwrap itself would die on SIGTERM and take the sandbox down at once, so it
 *   is started through `env --ignore-signal` and the command through
 *   `env --default-signal`: a group SIGTERM reaches only the command and its
 *   descendants, which get the caller's grace period before SIGKILL.
 */
import { lstatSync, mkdtempSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../brand.ts"
import type { SandboxPolicy } from "./policy.ts"

export interface BwrapOptions {
  readonly bwrapPath: string
  /** GNU env supporting --ignore-signal/--default-signal, or null to skip the signal trampoline. */
  readonly envPath: string | null
  /** An empty file with mode 000 to bind over hidden files. Default: one created per process. */
  readonly maskFile?: string
}

const TRAMPOLINE_SIGNALS = "TERM,INT,HUP"
/** Read-only system paths when `readRest` is false. */
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/opt", "/nix", "/run/systemd/resolve"]

/** The full argv (bwrap first, the command last) that runs `command` in `cwd` under `policy`. */
export function bwrapArgv(policy: SandboxPolicy, command: readonly string[], cwd: string, options: BwrapOptions): string[] {
  const args = [
    "--die-with-parent",
    "--unshare-user-try",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(policy.network.mode === "off" ? ["--unshare-net"] : []),
    ...readArgs(policy),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    // Before the writable roots, so roots under /tmp are bound on top of it.
    ...(policy.tempRoot ? ["--bind", existingRealpath(policy.tempRoot) ?? policy.tempRoot, "/tmp"] : ["--tmpfs", "/tmp"]),
    ...policy.writableRoots.flatMap((root) => {
      const real = existingRealpath(root)
      return real ? ["--bind", real, real] : []
    }),
    // Last, so they cover anything above, including paths inside writable roots.
    ...policy.hiddenPaths.flatMap((path) => hideArgs(path, options)),
    "--chdir",
    cwd,
  ]
  const inner = options.envPath ? [options.envPath, `--default-signal=${TRAMPOLINE_SIGNALS}`, ...command] : [...command]
  const outer = options.envPath ? [options.envPath, `--ignore-signal=${TRAMPOLINE_SIGNALS}`, options.bwrapPath] : [options.bwrapPath]
  return [...outer, ...args, "--", ...inner]
}

function readArgs(policy: SandboxPolicy) {
  if (policy.readRest) return ["--ro-bind", "/", "/"]
  return [...SYSTEM_PATHS, ...(policy.readableRoots ?? [])].flatMap((path) => {
    const stat = lstatOrNull(path)
    if (!stat) return []
    // Merged-/usr systems: /bin -> usr/bin must stay a symlink, or binaries resolve twice.
    if (stat.isSymbolicLink() && SYSTEM_PATHS.includes(path)) return ["--symlink", readlinkSync(path), path]
    const real = existingRealpath(path)
    return real ? ["--ro-bind", real, real] : []
  })
}

/** A directory becomes an empty mode-000 tmpfs; anything else (file, socket) is covered by the mode-000 mask file. */
function hideArgs(path: string, options: BwrapOptions) {
  const real = existingRealpath(path)
  if (!real) return []
  if (statSync(real).isDirectory()) return ["--perms", "0000", "--tmpfs", real]
  return ["--ro-bind", options.maskFile ?? processMaskFile(), real]
}

let maskFile: string | null = null

/**
 * bwrap can only create files inside the sandbox from a file descriptor, so a
 * hidden file is covered by binding this host file over it. Mode 000 and no
 * capabilities inside the sandbox make every open fail with EACCES (a
 * /dev/null bind would read as empty instead of failing).
 */
function processMaskFile() {
  if (maskFile && lstatOrNull(maskFile)) return maskFile
  const dir = mkdtempSync(join(tmpdir(), `${brand.directory}-sandbox-`))
  const file = join(dir, "hidden")
  writeFileSync(file, "")
  chmodSync(file, 0o000)
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
  maskFile = file
  return file
}

function existingRealpath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}
