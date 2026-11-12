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
 * - a shell command that ran with network access the harness granted (an escalation);
 * - the result of a subagent whose own conversation was tainted when it ended,
 *   and what a running subagent has said so far, shown to its parent while
 *   the subagent's conversation is tainted;
 * - a wake-up's firing that carries a webhook's body or the output of a check
 *   that ran with the network or without the sandbox, from its admission on.
 * - the text of a hook that reached the model (a refusal's reason, a note, a
 *   stop message) when the hook ran with the network by the user's grant
 *   (`sandbox: false` in the user's own file), or when it is a project's hook
 *   in a repository the user marked untrusted (`hooks/trust.ts`, `hookTaints`);
 * - the diagnostics note of a language server a project's configuration
 *   chose, in such a repository. Any other note is not one: it is the edited
 *   file's own code and the messages of a program the user configured.
 *
 * An MCP bridge call says in its result whether what it returned is content
 * the harness does not control (`untrusted`, from the server's configuration
 * and from whether anything the server wrote is in the text). Such a result
 * is a source when it says so, and not otherwise: a call to a server the
 * user's configuration marks as trusted, or one that was refused before
 * anything was sent, brought nothing in. A search of the catalogue is a source
 * only for the text the catalogue never carries (a server's notes, the error
 * text of a server that is unavailable): the names, descriptions and input
 * schemas of an untrusted server's tools are not one, in a search as in the
 * catalogue.
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
      /**
       * What an MCP bridge call recorded about its own result: whether it
       * holds content an untrusted server wrote. Absent or `null` for every
       * other tool, which is then judged by its class and origin alone.
       */
      readonly untrusted?: boolean | null
    }
  /** The result of a subagent whose own conversation held untrusted content: what it says may carry that content on. */
  | { readonly kind: "subagent_result"; readonly at: number; readonly session: string }
  /** Input admitted from outside the harness: a wake-up's firing with a webhook's body or a networked check's output. */
  | { readonly kind: "untrusted_input"; readonly at: number; readonly wakeId: string; readonly carries: "webhook_body" | "check_output" }
  /** A hook's own text reached the model, and the hook's record says it is content the harness does not control. */
  | { readonly kind: "hook_output"; readonly at: number; readonly hook: string; readonly taint: "hook-network" | "hook-untrusted-project" }
  /** The diagnostics note of a language server this project's configuration chose, in a repository marked untrusted. */
  | { readonly kind: "diagnostics_note"; readonly at: number; readonly server: string }
  /** The user said the conversation is trustworthy again. */
  | { readonly kind: "taint_cleared"; readonly at: number }
  /** Recorded for completeness; changes nothing. */
  | { readonly kind: "compaction"; readonly at: number }

export type TaintSourceKind = "network-tool" | "mcp-tool" | "outside-file" | "untrusted-file" | "network-command" | "subagent" | "wake-up" | "hook-network" | "hook-untrusted-project" | "lsp-untrusted-project"

export interface TaintSource {
  readonly at: number
  /** The tool whose result it was; for a wake-up's firing, the wake-up's ID; for a hook, its name; for a diagnostics note, the language server's name. */
  readonly tool: string
  readonly kind: TaintSourceKind
  /** The path, for file sources; the child session, for a subagent; what the firing carried (`webhook_body`, `check_output`), for a wake-up. */
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
    const found: TaintSource[] =
      entry.kind === "subagent_result"
        ? [{ at: entry.at, tool: "subagent", kind: "subagent", path: entry.session }]
        : entry.kind === "untrusted_input"
          ? [{ at: entry.at, tool: entry.wakeId, kind: "wake-up", path: entry.carries }]
          : entry.kind === "hook_output"
            ? [{ at: entry.at, tool: entry.hook, kind: entry.taint, path: null }]
            : entry.kind === "diagnostics_note"
              ? [{ at: entry.at, tool: entry.server, kind: "lsp-untrusted-project", path: null }]
              : sourcesOf(entry, globs)
    if (found.length === 0) return state
    return { tainted: true, since: state.since ?? entry.at, sources: [...state.sources, ...found] }
  }, CLEAN)
}

function sourcesOf(entry: Extract<HistoryEntry, { kind: "tool_result" }>, globs: readonly Bun.Glob[]): TaintSource[] {
  const source = (kind: TaintSourceKind, path: string | null = null): TaintSource => ({ at: entry.at, tool: entry.tool, kind, path })
  // A bridge call knows what its result holds; any other MCP tool is a source whatever it declares.
  if (entry.untrusted != null) return entry.untrusted ? [source("mcp-tool")] : []
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
          : first.kind === "subagent"
            ? `subagent ${first.path}, whose own conversation holds untrusted content,`
          : first.kind === "wake-up"
            ? `the wake-up ${first.tool} (${first.path === "webhook_body" ? "the body of a webhook request" : "the output of a check that could use the network"})`
          : first.kind === "hook-network"
            ? `the hook "${first.tool}", which runs outside the sandbox with the network,`
          : first.kind === "hook-untrusted-project"
            ? `the hook "${first.tool}" of this project's configuration, which is marked untrusted,`
          : first.kind === "lsp-untrusted-project"
            ? `the language server "${first.tool}" of this project's configuration, which is marked untrusted,`
          : `${first.path} (${first.kind === "outside-file" ? "outside the workspace" : "marked untrusted"})`
  const more = taint.sources.length > 1 ? ` and ${taint.sources.length - 1} more` : ""
  return `Content from ${what}${more} is in this conversation and may contain instructions aimed at the model.`
}
