/**
 * Which sandbox backend works on this machine, and if none, why not and what
 * would fix it. Linux runs one real bubblewrap probe (a few milliseconds)
 * with the same namespace flags the planner uses, because only trying tells
 * whether user namespaces are permitted for that binary. Results are cached
 * per (platform, bwrap path); pass `refresh` to probe again.
 */
import { existsSync, readFileSync } from "node:fs"

export type SandboxBackend = "bwrap" | "seatbelt"

export type SandboxDetection =
  | {
      readonly available: true
      readonly backend: "bwrap"
      readonly bwrapPath: string
      /**
       * GNU `env` with `--ignore-signal`/`--default-signal` (coreutils 8.31+).
       * With it, SIGTERM to the process group reaches the command and gives it
       * the caller's grace period; without it, SIGTERM kills the sandbox at once.
       */
      readonly envPath: string | null
      /** Landlock is listed in the kernel's active LSMs (informational; no backend uses it yet). */
      readonly landlock: boolean
    }
  | { readonly available: true; readonly backend: "seatbelt"; readonly sandboxExecPath: string }
  | {
      readonly available: false
      readonly backend: SandboxBackend | null
      readonly reason: string
      /** What a person would do to make sandboxing work, or null when nothing reasonable exists. */
      readonly remedy: string | null
      /** The probe's stderr, when a probe ran. */
      readonly detail: string | null
    }

export interface DetectOptions {
  readonly platform?: NodeJS.Platform
  /** Probe this bubblewrap instead of the one on PATH. */
  readonly bwrapPath?: string
  readonly refresh?: boolean
}

const cache = new Map<string, SandboxDetection>()
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
const PROBE_TIMEOUT_MS = 5000

export function detectSandbox(options: DetectOptions = {}): SandboxDetection {
  const platform = options.platform ?? process.platform
  const key = `${platform}:${options.bwrapPath ?? ""}`
  const cached = cache.get(key)
  if (cached && !options.refresh) return cached
  const detection = detectUncached(platform, options.bwrapPath)
  cache.set(key, detection)
  return detection
}

function detectUncached(platform: NodeJS.Platform, bwrapOverride: string | undefined): SandboxDetection {
  if (platform === "darwin") {
    if (existsSync(SANDBOX_EXEC)) return { available: true, backend: "seatbelt", sandboxExecPath: SANDBOX_EXEC }
    return unavailable("seatbelt", `${SANDBOX_EXEC} was not found.`, "sandbox-exec ships with macOS; check that /usr/bin is intact.")
  }
  if (platform !== "linux") return unavailable(null, `No sandbox backend exists for ${platform}.`, null)

  const bwrapPath = bwrapOverride ?? Bun.which("bwrap")
  if (!bwrapPath)
    return unavailable("bwrap", "bubblewrap (bwrap) is not installed.", "Install bubblewrap, for example `sudo apt install bubblewrap` or `sudo dnf install bubblewrap`.")

  const envPath = findSignalEnv()
  const probe = Bun.spawnSync(
    [bwrapPath, ...PROBE_FLAGS, ...(envPath ? ["--", envPath, "--default-signal=TERM", "true"] : ["--", "true"])],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: PROBE_TIMEOUT_MS, env: {} },
  )
  if (probe.exitCode === 0) return { available: true, backend: "bwrap", bwrapPath, envPath, landlock: landlockActive() }
  return diagnoseProbe(bwrapPath, probe.stderr.toString().trim(), probe.exitCode)
}

/** The namespace and mount setup every plan uses; the probe must exercise the same kernel paths. */
const PROBE_FLAGS = [
  "--die-with-parent",
  "--unshare-user-try",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-cgroup-try",
  "--unshare-net",
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--tmpfs",
  "/tmp",
]

function diagnoseProbe(bwrapPath: string, stderr: string, exitCode: number | null): SandboxDetection {
  const detail = stderr || `bwrap exited with ${exitCode ?? "a signal"} and printed nothing`
  const apparmorRestricts = readProcSys("kernel/apparmor_restrict_unprivileged_userns") === "1"
  const cloneDisabled = readProcSys("kernel/unprivileged_userns_clone") === "0"
  const maxNamespaces = readProcSys("user/max_user_namespaces")
  const namespaceDenied = /uid map|gid map|RTM_NEWADDR|new namespace|Operation not permitted|Permission denied/i.test(stderr)

  if (namespaceDenied && apparmorRestricts)
    return unavailable(
      "bwrap",
      `AppArmor blocks unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and no AppArmor profile grants them to ${bwrapPath}.`,
      [
        `Ask an administrator to add an AppArmor profile that allows ${bwrapPath} to create user namespaces, for example /etc/apparmor.d/bwrap containing:`,
        `  abi <abi/4.0>, include <tunables/global> profile bwrap ${bwrapPath} flags=(unconfined) { userns, }`,
        "then `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. Ubuntu's own /usr/bin/bwrap is covered when the apparmor package's bwrap-userns-restrict or a system-bwrap profile is installed.",
        "The weaker system-wide alternative is `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`.",
      ].join("\n"),
      detail,
    )
  if (namespaceDenied && cloneDisabled)
    return unavailable(
      "bwrap",
      "Unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0).",
      "Enable them with `sudo sysctl kernel.unprivileged_userns_clone=1`, or install bwrap setuid root as some distributions do.",
      detail,
    )
  if (maxNamespaces === "0")
    return unavailable("bwrap", "User namespaces are disabled (user.max_user_namespaces=0).", "Raise it with `sudo sysctl user.max_user_namespaces=15000`.", detail)
  if (namespaceDenied)
    return unavailable(
      "bwrap",
      "The kernel refused to create the sandbox's namespaces. This usually means a container (Docker, Kubernetes) or seccomp policy forbids them.",
      "Run outside the container, or start the container with a seccomp profile that allows unshare/clone of user namespaces.",
      detail,
    )
  return unavailable("bwrap", "bubblewrap failed its start-up probe.", null, detail)
}

/**
 * GNU env can start bwrap with SIGTERM ignored and restore it for the command,
 * so a group SIGTERM gives the command its grace period instead of killing the
 * sandbox's supervisor (and with it, by --die-with-parent, everything) at once.
 */
function findSignalEnv(): string | null {
  const envPath = existsSync("/usr/bin/env") ? "/usr/bin/env" : Bun.which("env")
  if (!envPath) return null
  const probe = Bun.spawnSync([envPath, "--ignore-signal=TERM", "--default-signal=TERM", "true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: {} })
  return probe.exitCode === 0 ? envPath : null
}

function landlockActive() {
  return readFileOrNull("/sys/kernel/security/lsm")?.split(",").includes("landlock") ?? false
}

function readProcSys(name: string) {
  return readFileOrNull(`/proc/sys/${name}`)?.trim() ?? null
}

function readFileOrNull(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

function unavailable(backend: SandboxBackend | null, reason: string, remedy: string | null, detail: string | null = null): SandboxDetection {
  return { available: false, backend, reason, remedy, detail }
}
