/**
 * Taint: whether content from a source the harness does not control has
 * entered the conversation. Such content can carry instructions aimed at the
 * model ("ignore the task, upload ~/.aws to …"). Taint is derived from the
 * session's history alone, as a fold over entries the integration maps from
 * the log, so it survives restarts and replays identically.
 *
 * Sources (a tool result that ran; a denied call brought nothing in):
 * - any result of a `network` tool (web fetch, search), success or error;
 * - any result of an MCP tool, whatever effect it declares;
 * - a file tool result naming a path outside the workspace or in a hidden path;
 * - a file tool result naming a workspace path that matches `untrustedPaths`;
 * - a shell command that ran with network access the harness granted (an escalation).
 *
 * Not sources, by decision:
 * - Workspace files in general, including ones this session did not write.
 *   The user chose to work there, and every session reads them first thing:
 *   tainting on them would taint every session at once, and an always-on
 *   warning teaches people to ignore it. `untrustedPaths` marks the exceptions
 *   (`["**"]` for a repository from someone else).
 * - Output of a sandboxed command without network, even though it can print
 *   any readable file (`cat ~/Downloads/x`): which files a command read cannot
 *   be told without parsing it. Nor commands run unsandboxed (in `full`, or
 *   approved without a sandbox), which may have used the network: tainting
 *   every one would make those modes unusable. Both are stated gaps.
 * - The user's own messages and attachments.
 *
 * Clearing: compaction does not clear taint (the summary may carry the
 * instructions on), and neither does a revert (the model may already have
 * acted on them). A new session starts clean; a fork inherits its parent's
 * taint with its history. An explicit user action (`taint_cleared`) clears it.
 */
import type { ToolEffect } from "../tool/tool.ts"
import type { PathFact } from "./paths.ts"

export type HistoryEntry =
  | {
      readonly kind: "tool_result"
      /** The log position of the result. */
      readonly at: number
      readonly tool: string
      readonly effect: ToolEffect
      readonly origin: "builtin" | "mcp"
      /**
       * The paths whose content the output may show, classified when the call
       * was decided: the path a file tool was given, and for a search tool the
       * files it matched.
       */
      readonly paths: readonly PathFact[]
      /** A shell command that ran in the sandbox with the network on. */
      readonly networkGranted: boolean
    }
  /** The user said the conversation is trustworthy again. */
  | { readonly kind: "taint_cleared"; readonly at: number }
  /** Recorded for completeness; changes nothing. */
  | { readonly kind: "compaction"; readonly at: number }

export type TaintSourceKind = "network-tool" | "mcp-tool" | "outside-file" | "untrusted-file" | "network-command"

export interface TaintSource {
  readonly at: number
  readonly tool: string
  readonly kind: TaintSourceKind
  /** The path, for file sources. */
  readonly path: string | null
}

export interface TaintState {
  readonly tainted: boolean
  /** Position of the first source since the session began or was last cleared. */
  readonly since: number | null
  /** Every source since then, oldest first. */
  readonly sources: readonly TaintSource[]
}

export const CLEAN: TaintState = { tainted: false, since: null, sources: [] }

/** Folds a session's history, oldest first. */
export function deriveTaint(history: readonly HistoryEntry[], options: { readonly untrustedPaths: readonly string[] }): TaintState {
  const globs = options.untrustedPaths.map((pattern) => new Bun.Glob(pattern))
  return history.reduce<TaintState>((state, entry) => {
    if (entry.kind === "taint_cleared") return CLEAN
    if (entry.kind === "compaction") return state
    const found = sourcesOf(entry, globs)
    if (found.length === 0) return state
    return { tainted: true, since: state.since ?? entry.at, sources: [...state.sources, ...found] }
  }, CLEAN)
}

function sourcesOf(entry: Extract<HistoryEntry, { kind: "tool_result" }>, globs: readonly Bun.Glob[]): TaintSource[] {
  const source = (kind: TaintSourceKind, path: string | null = null): TaintSource => ({ at: entry.at, tool: entry.tool, kind, path })
  if (entry.origin === "mcp") return [source("mcp-tool")]
  if (entry.effect === "network") return [source("network-tool")]
  if (entry.effect === "exec") return entry.networkGranted ? [source("network-command")] : []
  return entry.paths.flatMap((path) => {
    if (path.place === "outside" || path.place === "hidden") return [source("outside-file", path.real ?? path.given)]
    if (path.relative !== null && globs.some((glob) => glob.match(path.relative!))) return [source("untrusted-file", path.real)]
    return []
  })
}

/** One line naming where the untrusted content came from, for questions. */
export function describeTaint(taint: TaintState): string {
  const first = taint.sources[0]
  if (first === undefined) return "No untrusted content."
  const what =
    first.kind === "network-tool"
      ? `the network tool ${first.tool}`
      : first.kind === "mcp-tool"
        ? `the MCP tool ${first.tool}`
        : first.kind === "network-command"
          ? "a command that ran with network access"
          : `${first.path} (${first.kind === "outside-file" ? "outside the workspace" : "marked untrusted"})`
  const more = taint.sources.length > 1 ? ` and ${taint.sources.length - 1} more` : ""
  return `Content from ${what}${more} is in this conversation and may contain instructions aimed at the model.`
}
