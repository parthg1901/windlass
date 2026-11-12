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
 * sandbox produces (EROFS, EACCES, a DNS or connection failure). A wrong guess
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
  readonly suspects: readonly ("network" | "write")[]
  /** Appended to the model-facing output, once, before the result is stored. */
  readonly note: string
}

const WRITE_MARKERS = /Read-only file system|EROFS|Permission denied|EACCES|Operation not permitted|EPERM/
const NETWORK_MARKERS =
  /Could not resolve|Temporary failure in name resolution|Name or service not known|nodename nor servname|getaddrinfo|EAI_AGAIN|ENOTFOUND|Network is unreachable|ENETUNREACH|Connection refused|ECONNREFUSED|No route to host|EHOSTUNREACH|Failed to establish a new connection|network is unreachable/i

/** A note for a failed sandboxed command whose output shows an error the sandbox causes; null otherwise. */
export function sandboxHint(run: SandboxRun): SandboxHint | null {
  if (!run.sandboxed || run.exitCode === null || run.exitCode === 0) return null
  const suspects = [
    ...(!run.network && NETWORK_MARKERS.test(run.output) ? (["network"] as const) : []),
    ...(WRITE_MARKERS.test(run.output) ? (["write"] as const) : []),
  ]
  if (suspects.length === 0) return null
  const limits = run.network ? "writes only inside the workspace and the temp directory" : "no network, and writes only inside the workspace and the temp directory"
  const ask = suspects
    .map((suspect) => (suspect === "network" ? '`sandbox: { "network": true }`' : '`sandbox: { "write": ["<directory>"] }`'))
    .join(" or ")
  return {
    suspects,
    note: `[sandbox] This command ran in the sandbox (${limits}), and its output shows an error the sandbox can cause. If it needs that access, run it again with ${ask}; the user will be asked.`,
  }
}
