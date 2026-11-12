/**
 * The sandbox policy: what a sandboxed command may write, read, reach on the
 * network, and which environment variables it receives. The policy is
 * backend-neutral; `bwrap.ts` and `seatbelt.ts` translate it.
 */
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { brand } from "../brand.ts"

/**
 * `off`: no network at all (on Linux not even loopback to the host). `on`:
 * unrestricted. A later `{ mode: "allow"; hosts: readonly string[] }` member
 * can be added without changing the other two.
 */
export type NetworkPolicy = { readonly mode: "off" } | { readonly mode: "on" }

export type EnvPolicy =
  /** Pass only these names (exact match). */
  | { readonly mode: "allow"; readonly names: readonly string[] }
  /**
   * Pass everything except `names` and, unless `stripCredentials` is false,
   * anything `isCredentialName` matches. `keep` exempts names from the
   * credential heuristic (not from `names`).
   */
  | { readonly mode: "deny"; readonly names?: readonly string[]; readonly stripCredentials?: boolean; readonly keep?: readonly string[] }

export interface SandboxPolicy {
  /** Absolute paths the command may write (recursively). Paths that do not exist are skipped. */
  readonly writableRoots: readonly string[]
  /**
   * A host directory the command uses as its temp directory: mounted at
   * `/tmp` on Linux, allowed and set as `TMPDIR` on macOS. Without it Linux
   * gets a private, empty `/tmp` that disappears with the command, and macOS
   * gets no writable temp directory.
   */
  readonly tempRoot?: string
  /** Whether the rest of the filesystem is readable (never writable). Default true. */
  readonly readRest: boolean
  /** With `readRest: false`, extra absolute paths that stay readable (system directories always are). */
  readonly readableRoots?: readonly string[]
  /**
   * Absolute paths the command may read and not write, also inside a writable
   * root: what would otherwise run later outside the sandbox (`.git/hooks`,
   * `.git/config`) or steer the harness (its project directory). Paths that do
   * not exist are skipped. Hidden paths still win over them.
   */
  readonly readOnlyPaths?: readonly string[]
  /** Absolute paths the command cannot read or write at all. They win over every other rule. */
  readonly hiddenPaths: readonly string[]
  readonly network: NetworkPolicy
  readonly env: EnvPolicy
}

export interface DefaultPolicyOptions {
  readonly workspace: string
  readonly tempRoot?: string
  readonly network?: NetworkPolicy
  readonly home?: string
  /** Used for `XDG_*` lookups. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform
  readonly uid?: number
}

/** Workspace writable, everything else read-only, credentials hidden, network off, credential variables stripped. */
export function defaultPolicy(options: DefaultPolicyOptions): SandboxPolicy {
  return {
    writableRoots: [options.workspace],
    tempRoot: options.tempRoot,
    readRest: true,
    hiddenPaths: defaultHiddenPaths(options),
    network: options.network ?? { mode: "off" },
    env: { mode: "deny" },
  }
}

/** Credential stores, the harness's own data and config, and sockets that would let a command act outside the sandbox. */
export function defaultHiddenPaths(options: Omit<DefaultPolicyOptions, "workspace" | "tempRoot" | "network"> = {}): string[] {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const inHome = [
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".oci",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".npmrc",
    ".pypirc",
    ".vault-token",
    ".password-store",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".gem/credentials",
    ".terraform.d/credentials.tfrc.json",
    ".config/gcloud",
    ".config/gh",
    ".config/hub",
    ".config/git/credentials",
    ".config/doctl",
    ".config/op",
    ".local/share/keyrings",
    // other coding agents keep provider credentials here
    ".codex",
    ".claude",
    ".claude.json",
    // browser profiles hold session cookies
    ".mozilla",
    ".config/google-chrome",
    ".config/chromium",
  ].map((path) => join(home, path))
  const harness = [
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), brand.directory),
    join(env.XDG_CONFIG_HOME || join(home, ".config"), brand.directory),
  ]
  if (platform === "darwin")
    return [
      ...inHome,
      ...harness,
      join(home, "Library", "Application Support", brand.directory),
      join(home, "Library", "Keychains"),
      join(home, "Library", "Cookies"),
      join(home, "Library", "Application Support", "Google", "Chrome"),
      join(home, "Library", "Application Support", "Firefox"),
      "/var/run/docker.sock",
    ]
  const uid = options.uid ?? process.getuid?.() ?? 0
  return [
    ...inHome,
    ...harness,
    // The session bus and systemd user manager live here: `systemd-run --user` would run a command outside the sandbox.
    env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
    // Container daemons are root on the host for anyone who can reach them, network namespace or not.
    "/run/docker.sock",
    "/var/run/docker.sock",
    "/run/podman",
    "/run/containerd",
    "/var/snap/lxd/common/lxd/unix.socket",
    "/var/lib/incus/unix.socket",
  ]
}

const CREDENTIAL_WORDS = ["TOKEN", "KEY", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "PRIVATE", "COOKIE"]
/** Whole `_`-separated segments, so `GIT_AUTHOR_NAME` is not caught by `AUTH`. */
const CREDENTIAL_SEGMENTS = ["AUTH", "PAT"]
const CREDENTIAL_PREFIXES = [
  "AWS_",
  "AZURE_",
  "ARM_",
  "GOOGLE_",
  "GCLOUD_",
  "GCP_",
  "CLOUDSDK_",
  "OCI_",
  "DIGITALOCEAN_",
  "HCLOUD_",
  "LINODE_",
  "VAULT_",
  "OPENAI_",
  "ANTHROPIC_",
  "CLAUDE_",
  "GEMINI_",
  "MISTRAL_",
  "GROQ_",
  "COHERE_",
  "OPENROUTER_",
  "HF_",
  "HUGGINGFACE_",
  "HUGGING_FACE_",
  "XAI_",
  "DEEPSEEK_",
  "TOGETHER_",
  "FIREWORKS_",
  "REPLICATE_",
  "PERPLEXITY_",
  "VOYAGE_",
  "LANGCHAIN_",
  "LANGSMITH_",
]
const CREDENTIAL_NAMES = ["DATABASE_URL", "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONFIG", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "NETRC"]

/** True for names that look like they carry a credential (case-insensitive). Errs towards stripping. */
export function isCredentialName(name: string): boolean {
  const upper = name.toUpperCase()
  if (CREDENTIAL_NAMES.includes(upper)) return true
  if (CREDENTIAL_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
  if (CREDENTIAL_WORDS.some((word) => upper.includes(word))) return true
  return upper.split("_").some((segment) => CREDENTIAL_SEGMENTS.includes(segment))
}

/** The environment the child receives under `policy`. Undefined values are dropped. */
export function filterEnv(env: Readonly<Record<string, string | undefined>>, policy: EnvPolicy): Record<string, string> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  if (policy.mode === "allow") return Object.fromEntries(entries.filter(([name]) => policy.names.includes(name)))
  const strip = policy.stripCredentials ?? true
  return Object.fromEntries(
    entries.filter(([name]) => {
      if (policy.names?.includes(name)) return false
      if (!strip || policy.keep?.includes(name)) return true
      return !isCredentialName(name)
    }),
  )
}

/** Throws on a policy no backend can apply correctly (relative paths). */
export function assertValidPolicy(policy: SandboxPolicy) {
  const paths = [...policy.writableRoots, ...policy.hiddenPaths, ...(policy.readableRoots ?? []), ...(policy.readOnlyPaths ?? []), ...(policy.tempRoot ? [policy.tempRoot] : [])]
  const relative = paths.filter((path) => !isAbsolute(path))
  if (relative.length > 0) throw new TypeError(`Sandbox policy paths must be absolute: ${relative.join(", ")}`)
}
