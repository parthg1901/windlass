/**
 * Escalation: retrying a sandboxed command with more access.
 *
 * Detection. The sandbox wrapper only plans the spawn; the result the shell
 * tool sees is an exit code and the output. bwrap reports no denials, and a
 * failed write or connection looks the same to the command whether the
 * sandbox or the host refused it. So the harness cannot know that the sandbox
 * caused a failure. It knows reliably only that the command ran sandboxed,
 * with what access, and that it failed. `sandboxHint` adds a factual note to
 * a failed sandboxed command's output when the output contains an error the
 * sandbox produces (EROFS, EACCES, a DNS or connection failure), and to one
 * that exited 0 when its output shows the network's refusal as a client
 * reports it (a pipeline hid the failure). A wrong guess
 * is harmless: the note costs a few lines, and nothing runs with more access
 * until the model asks explicitly and the user approves.
 *
 * Request. The model asks with an explicit argument on the shell tool,
 * `sandbox: { "network": true, "write": ["<dir>"] }`, on a retry or up front
 * (`npm install`). The harness never widens on its own. The decision then
 * asks the user "Allow network for this command?" or "Allow this command to
 * write to <real path>?", and what can be remembered is that capability
 * (network for sandboxed commands in this session; writes under that path),
 * never the command.
 */
import { brand } from "../brand.ts"
import { DecodeError, type Validator, boolean, nonEmptyString } from "../validate.ts"
import { type PathContext, type PathFact, pathFact } from "./paths.ts"

export interface EscalationRequest {
  readonly network: boolean
  /** Paths as the model gave them. */
  readonly write: readonly string[]
}

/** An escalation with its paths classified, as `decide` takes it. */
export interface Escalation {
  readonly network: boolean
  readonly write: readonly PathFact[]
}

export const MAX_ESCALATION_PATHS = 8

/** The shell tool's `sandbox` property, for its `inputSchema`. */
export const escalationSchema = {
  type: "object",
  description:
    "Ask the user for more access than the sandbox gives (no network; writes only inside the workspace and the temp directory). Use only when the command needs it, for example after it failed because of the sandbox.",
  properties: {
    network: { type: "boolean", description: "Run with network access." },
    write: {
      type: "array",
      items: { type: "string", minLength: 1 },
      maxItems: MAX_ESCALATION_PATHS,
      description: "Directories outside the workspace the command needs to write.",
    },
  },
  additionalProperties: false,
} as const

/** Validates the `sandbox` argument (absent: null). An empty request is null too. */
export const escalationRequest: Validator<EscalationRequest | null> = (input, path) => {
  if (input === undefined || input === null) return null
  if (typeof input !== "object" || Array.isArray(input)) throw new DecodeError(path, "object", input)
  const record = input as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => key !== "network" && key !== "write")
  if (unknown !== undefined) throw new DecodeError(`${path}.${unknown}`, "no such key", record[unknown])
  const network = record.network === undefined ? false : boolean(record.network, `${path}.network`)
  const write = record.write === undefined ? [] : record.write
  if (!Array.isArray(write) || write.length > MAX_ESCALATION_PATHS)
    throw new DecodeError(`${path}.write`, `array of at most ${MAX_ESCALATION_PATHS} paths`, write)
  const paths = [...new Set(write.map((item, index) => nonEmptyString(item, `${path}.write[${index}]`)))]
  return network || paths.length > 0 ? { network, write: paths } : null
}

/** Classifies the request's paths. */
export function escalationFacts(request: EscalationRequest, context: PathContext): Escalation {
  return { network: request.network, write: request.write.map((path) => pathFact(path, context)) }
}

export interface SandboxRun {
  /** The command ran under the sandbox (not unsandboxed, not refused). */
  readonly sandboxed: boolean
  /** It had the network on. */
  readonly network: boolean
  /** Null when it was stopped (timeout, interrupt). */
  readonly exitCode: number | null
  readonly output: string
}

export interface SandboxHint {
  /**
   * `git`: the command tried to change what the sandbox keeps read-only
   * whatever access is granted (the repository's git configuration and
   * hooks, the harness's project directory); no `sandbox` argument helps.
   */
  readonly suspects: readonly ("network" | "write" | "git")[]
  /** Appended to the model-facing output, once, before the result is stored. */
  readonly note: string
}

const WRITE_MARKERS = /Read-only file system|EROFS|Permission denied|EACCES|Operation not permitted|EPERM/
const NETWORK_MARKERS =
  /Could not resolve|Temporary failure in name resolution|Name or service not known|nodename nor servname|getaddrinfo|EAI_AGAIN|ENOTFOUND|Network is unreachable|ENETUNREACH|Connection refused|ECONNREFUSED|No route to host|EHOSTUNREACH|Failed to establish a new connection|network is unreachable|Failed to connect to|Couldn't connect to server|ConnectionRefused|DNSResolveFailed/i
/**
 * What a client prints when a name lookup failed, naming the host it looked
 * up. With the network off every connection to another machine starts with
 * a lookup that fails, so this is the sandbox's refusal as programs report
 * it. It is matched also when the command exited 0, because a pipeline
 * (`curl ... | head`) or `|| true` hides the exit code: hence only these
 * shapes, each where the client prints it, at the start of a line (`^`
 * after a newline or a carriage return) with the client's own prefix, so a
 * comment, a sentence or a string in source code that quotes the message
 * does not count; and a dotted host name, not a word, a `${host}` or a quote,
 * must follow. Seen under bubblewrap: curl (after its progress meter, on the
 * same line, when the meter is shown) and git, ssh, wget, Python, Node and
 * npm, Bun.
 */
const HOST = "[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?![A-Za-z0-9${'\"`-]|\\.[A-Za-z0-9])"
const NETWORK_REFUSALS = new RegExp(
  [
    String.raw`^(?:[^\n]*--:--:-- +[0-9.]+[kMG]?)?curl: \(6\) Could not resolve host: ${HOST}`,
    String.raw`^fatal: unable to access '[^'\n]*': Could not resolve host: ${HOST}`,
    String.raw`^ssh: Could not resolve hostname ${HOST}:`,
    String.raw`^wget: unable to resolve host address ['‘"]?${HOST}`,
    String.raw`^Resolving ${HOST} \([^)\n]*\)\.\.\. failed: Temporary failure in name resolution`,
    String.raw`^[\w.-]+: ${HOST}: Temporary failure in name resolution`,
    String.raw`^npm (?:ERR!|error) [^\n]*getaddrinfo (?:EAI_AGAIN|ENOTFOUND|ETIMEOUT) ${HOST}`,
    // Node and Bun: the error, or the `[cause]` of `fetch failed`.
    String.raw`^(?: +\[cause\]: )?(?:[A-Z]\w*)?Error: getaddrinfo (?:EAI_AGAIN|ENOTFOUND|ETIMEOUT) ${HOST}`,
    // Python: the last line of the traceback, which starts with the exception's class.
    String.raw`^(?:[A-Za-z_]\w*\.)*\w*(?:Error|Exception|gaierror): [^\n]*\[Errno -3\] Temporary failure in name resolution`,
    String.raw`^error: DNSResolveFailed downloading`,
  ].join("|"),
  "m",
)
/** A write git or a hook installer reports when the sandbox's read-only git configuration, hooks or project directory refused it. */
const PROTECTED_MARKERS = new RegExp(
  [
    // git writes its configuration through a lock file renamed over it, and the file is a read-only mount point.
    String.raw`could not write config file [^\n]*: Device or resource busy`,
    String.raw`could not lock config file [^\n]*(?:Read-only file system|Device or resource busy)`,
    String.raw`[^\n]*\.git/(?:hooks|config)\b[^\n]*(?:Read-only file system|EROFS|Device or resource busy|EBUSY)`,
    String.raw`[^\n]*\.${brand.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\n]*(?:Read-only file system|EROFS)`,
  ].join("|"),
)

/**
 * A note for a sandboxed command whose output shows an error the sandbox
 * causes; null otherwise. A failed command (exit code not 0) is looked at for
 * every such error. One that exited 0 only for the network's refusal as
 * clients report it (`NETWORK_REFUSALS`): its failure was hidden by a
 * pipeline or `|| true`. A command that was stopped gets no note.
 */
export function sandboxHint(run: SandboxRun): SandboxHint | null {
  if (!run.sandboxed || run.exitCode === null) return null
  const failed = run.exitCode !== 0
  const lines = run.output.split("\n")
  const git = failed && lines.some((line) => PROTECTED_MARKERS.test(line))
  // A refused write to what stays read-only whatever is granted is not a reason to ask for writes.
  const write = failed && lines.some((line) => WRITE_MARKERS.test(line) && !PROTECTED_MARKERS.test(line))
  const network = !run.network && (failed ? NETWORK_MARKERS.test(run.output) : NETWORK_REFUSALS.test(run.output))
  const suspects = [...(network ? (["network"] as const) : []), ...(write ? (["write"] as const) : []), ...(git ? (["git"] as const) : [])]
  if (suspects.length === 0) return null
  const notes: string[] = []
  if (network || write) {
    const limits = run.network ? "writes only inside the workspace and the temp directory" : "no network, and writes only inside the workspace and the temp directory"
    const ask = [...(network ? ['`sandbox: { "network": true }`'] : []), ...(write ? ['`sandbox: { "write": ["<directory>"] }`'] : [])].join(" or ")
    const shows = failed ? "its output shows an error the sandbox can cause" : "its output shows that a network request failed, although it exited 0 (a pipeline or `|| true` hides a failure)"
    notes.push(`[sandbox] This command ran in the sandbox (${limits}), and ${shows}. If it needs that access, run it again with ${ask}; the user will be asked.`)
  }
  if (git)
    notes.push(
      `[sandbox] This command tried to change the repository's git configuration or hooks (\`.git/config\`, \`.git/hooks\`) or the harness's project directory (\`.${brand.directory}/\`). The sandbox keeps these read-only whatever access is granted, because what is written there runs later outside the sandbox; no \`sandbox\` argument changes that. Do not try to work around it. For a commit identity, pass it on the command (\`git -c user.name=<name> -c user.email=<email> commit ...\`). Otherwise tell the user the exact command and ask them to run it themselves.`,
    )
  return { suspects, note: notes.join("\n") }
}
