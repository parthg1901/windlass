/**
 * OS-level sandbox for shell commands. `sandboxCommand` turns a policy and a
 * command into the argv and environment to spawn, or explains why this
 * machine cannot sandbox. It spawns nothing itself; see README.md for how the
 * shell tool is expected to use it.
 */
import { bwrapArgv } from "./bwrap.ts"
import { type SandboxBackend, type SandboxDetection, detectSandbox } from "./detect.ts"
import { type SandboxPolicy, assertValidPolicy, filterEnv } from "./policy.ts"
import { seatbeltArgv } from "./seatbelt.ts"

export { detectSandbox, type DetectOptions, type SandboxBackend, type SandboxDetection } from "./detect.ts"
export {
  type DefaultPolicyOptions,
  type EnvPolicy,
  type NetworkPolicy,
  type SandboxPolicy,
  defaultHiddenPaths,
  defaultPolicy,
  filterEnv,
  isCredentialName,
} from "./policy.ts"
export { seatbeltProfile } from "./seatbelt.ts"
export { type CommandInput, type CommandSandbox, type CommandSandboxOptions, type GitLayout, createCommandSandbox, gitLayout, workspacePolicy } from "./command.ts"

export type SandboxCommand =
  | { readonly argv: readonly string[]; readonly cwd: string }
  /** Run with `<shellPath> -c <shell>`. Default shell: `bash` from PATH, else `/bin/sh`. */
  | { readonly shell: string; readonly shellPath?: string; readonly cwd: string }

export type SandboxPlan = {
  readonly kind: "ready"
  readonly backend: SandboxBackend
  /** Spawn exactly this, detached (own process group), with `env` and `cwd`. */
  readonly argv: string[]
  readonly env: Record<string, string>
  readonly cwd: string
  /**
   * Whether a SIGTERM to the process group gives the command a grace period
   * (true), or kills the whole sandbox immediately (false: Linux without GNU
   * env). SIGKILL to the group always kills everything.
   */
  readonly gracefulTermination: boolean
}

export type SandboxUnavailable = {
  readonly kind: "unavailable"
  readonly backend: SandboxBackend | null
  readonly reason: string
  readonly remedy: string | null
  readonly detail: string | null
}

export interface SandboxCommandOptions {
  /** The environment to filter for the child. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** A detection to use instead of `detectSandbox()` (which is cached). */
  readonly detection?: SandboxDetection
  /** Linux: the mode-000 file bound over hidden files. Default: one per user under the temp directory. */
  readonly maskFile?: string
}

export function sandboxCommand(policy: SandboxPolicy, command: SandboxCommand, options: SandboxCommandOptions = {}): SandboxPlan | SandboxUnavailable {
  assertValidPolicy(policy)
  const detection = options.detection ?? detectSandbox()
  if (!detection.available) return { kind: "unavailable", backend: detection.backend, reason: detection.reason, remedy: detection.remedy, detail: detection.detail }

  const argv = "argv" in command ? [...command.argv] : [command.shellPath ?? Bun.which("bash") ?? "/bin/sh", "-c", command.shell]
  const env = filterEnv(options.env ?? process.env, policy.env)
  if (detection.backend === "bwrap")
    return {
      kind: "ready",
      backend: "bwrap",
      argv: bwrapArgv(policy, argv, command.cwd, { bwrapPath: detection.bwrapPath, envPath: detection.envPath, maskFile: options.maskFile }),
      // Inside, /tmp is the private tmpfs or the temp root; a host TMPDIR would point at a read-only or missing path.
      env: { ...env, TMPDIR: "/tmp" },
      cwd: command.cwd,
      gracefulTermination: detection.envPath !== null,
    }
  return {
    kind: "ready",
    backend: "seatbelt",
    argv: seatbeltArgv(policy, argv, detection.sandboxExecPath),
    env: policy.tempRoot ? { ...env, TMPDIR: policy.tempRoot } : env,
    cwd: command.cwd,
    gracefulTermination: true,
  }
}
