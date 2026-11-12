/**
 * The harness features ACP v1 has no shape for, exposed as extension methods
 * and notifications. Every name is built from `brand.extensionPrefix` (a
 * leading underscore marks an ACP extension); `_meta` keys use the same name
 * without the underscore, as ACP's extensibility rules ask.
 */
import { brand } from "@windlass/core"

const prefix = brand.extensionPrefix
/** The namespace for `_meta` keys and capability entries: the extension prefix without its underscore. */
export const META_NAMESPACE = prefix.replace(/^_/, "")

export const EXT = {
  /** Request `{ sessionId, prompt: ContentBlock[] }` → `{ messageId }`: delivered at the next step boundary. Answers once admitted. */
  steer: `${prefix}/steer`,
  /** Request `{ sessionId, prompt: ContentBlock[] }` → `{ messageId }`: delivered once the session would otherwise go idle. */
  queue: `${prefix}/queue`,
  /** Request `{}` → `{ models: [...], defaultModel }`: the models and reasoning efforts the account offers. */
  models: `${prefix}/models`,
  /** Notification `{ sessionId, messageId, model, usage }` after every model call that reported usage. */
  usage: `${prefix}/usage`,
  /** Notification `{ sessionId, state, stopReason? }` when the session starts working, stops, or is found suspended. */
  state: `${prefix}/state`,
  /** Notification `{ sessionId, event, replay? }`: one harness event as is, to a client that opted in (`ClientMeta.events`). */
  event: `${prefix}/event`,
  /** Notification `TurnNotification`: how a turn ended, live and on `session/load`. */
  turn: `${prefix}/turn`,
  /** Notification `{ sessionId, kind, message }`: something the engine noticed that is not part of the log. */
  diagnostic: `${prefix}/diagnostic`,
  /** Request `RevertParams` → `RevertResult`: back to before a user message (the latest by default), files and conversation. */
  revert: `${prefix}/revert`,
  /** Request `RevertParams` without `messageId` → `RevertResult`: undoes the latest revert. */
  undoRevert: `${prefix}/undo_revert`,
  /** Request `{ sessionId, messageId }` → `{ withdrawn }`: takes back an admitted message that was not delivered yet. */
  withdraw: `${prefix}/withdraw`,
  /** Request `{ sessionId }` → `{}`: puts an archived (deleted) session back in the listing. */
  unarchive: `${prefix}/unarchive`,
  /** Request `{ sessionId }` → `SessionStateResult`: the stored state of a session open on this connection. */
  session: `${prefix}/session`,
  /** Request `{ sessionId, afterSeq?, limit? }` → `{ events }`: a session's stored events, also of one another process holds. */
  events: `${prefix}/events`,
  /** Request `{ cwd, session? }` → `{ sessionId, cwd }`: the session an ID or a unique start of one names, or the latest in `cwd`. */
  resolve: `${prefix}/resolve`,
  /**
   * Request `{ sessionId, mode?, unattended?, attended? }` → `ApprovalStateResult`: reads, and with a field sets, how
   * the session's tool calls are approved. `mode` is also the `approval` config option.
   */
  approval: `${prefix}/approval`,
  /** Request `{ sessionId }` → `{ cleared }`: the user says the conversation is trustworthy again (`taint.cleared`). */
  clearTaint: `${prefix}/clear_taint`,
  /** Notification `{ sessionId, tainted, text?, source?, replay? }`: the session became tainted (said once), or was cleared. */
  taint: `${prefix}/taint`,
  /** Notification `{ sessionId, kind, message }`: something about how the session's tools run that the user should read once. */
  notice: `${prefix}/notice`,
  /** Request `DiffParams` → `DiffResult`: the files a turn or a step changed, with bounded per-file patches, from the workspace snapshots. */
  diff: `${prefix}/diff`,
  /** Request `{ sessionId, title }` → `{ title }`: gives a session a title (`session.renamed`); the answer is the title as stored. */
  rename: `${prefix}/rename`,
  /** Request `{ sessionId }` → `CompactResult`: compacts the conversation now, and says what came of it. Answered when it is done. */
  compact: `${prefix}/compact`,
  /** Request `{ sessionId }` or `{ cwd }` → `AgentsResult`: the agents a session can run as, the definitions that could not be used, and the one in force. */
  agents: `${prefix}/agents`,
  /** Request `ForkParams` → `ForkResult`: a new session with the history of another up to a step boundary. The fork is not opened; load it to work in it. */
  fork: `${prefix}/fork`,
  /** Request `ReplayParams` → `ReplayResult`: replays a recorded session against a changed baseline. Its progress is the replay session's events, after `replayStarted`. */
  replay: `${prefix}/replay`,
  /** Notification `ReplayStartedNotification`: a replay this connection asked for has its session; its events follow under that session. */
  replayStarted: `${prefix}/replay_started`,
  /** Notification `ChildNotification`: one durable event of a subagent of a session open here, for a client that does not take the harness's events. */
  child: `${prefix}/child`,
  /** Request `{ sessionId }` → `McpStateResult`: the session's MCP servers, their state, tools and where each is configured. */
  mcp: `${prefix}/mcp`,
  /** Request `{ sessionId, name, fingerprint }` → `{ approved, servers }`: the user starts a server the project's configuration names, remembered for the project. */
  mcpApprove: `${prefix}/mcp_approve`,
  /** Notification `McpStateResult`: the session's servers changed (one started, failed, waits for approval, or was approved). */
  mcpChanged: `${prefix}/mcp_changed`,
  /** Request `{ sessionId }` → `HooksStateResult`: the session's hooks, each with its point, command, state and the file that defines it. */
  hooks: `${prefix}/hooks`,
  /** Request `{ sessionId, fingerprint }` → `{ approved, hooks }`: the user allows a hook the project's configuration names (exactly this definition), remembered for the project. */
  hookApprove: `${prefix}/hook_approve`,
  /** Notification `HooksStateResult`: the session's hooks changed (the configuration was read again, one waits for approval, was approved, or could not answer). */
  hooksChanged: `${prefix}/hooks_changed`,
  /** Request `{ sessionId }` → `LspStateResult`: the session's language servers, their state, the files they serve and where each is configured. */
  lsp: `${prefix}/lsp`,
  /** Request `{ sessionId, name, fingerprint }` → `{ approved, servers }`: the user allows a language server the project's configuration names, remembered for the project. */
  lspApprove: `${prefix}/lsp_approve`,
  /** Notification `LspStateResult`: the session's language servers changed (one started, failed, waits for approval, or was approved). */
  lspChanged: `${prefix}/lsp_changed`,
  /** Request `{ sessionId }` → `SkillsResult`: the skills of the session's directory, the shadowed ones and the ones that could not be loaded. */
  skills: `${prefix}/skills`,
  /** Request `{ sessionId }` → `WakeListResult`: the session's wake-ups, pending and ended, in the engine's words. */
  wakeups: `${prefix}/wakeups`,
  /** Request `WakeCreateParams` → `WakeCreateResult`: the user creates a wake-up for the session; a webhook's secret is in the answer, for the user only. */
  wakeCreate: `${prefix}/wake_create`,
  /** Request `{ sessionId, id }` → `{ cancelled, message }`: the user cancels a wake-up of the session. */
  wakeCancel: `${prefix}/wake_cancel`,
  /** Request `{ sessionId, id }` → `WakeSecretResult`: a webhook wake-up's URL and secret, for the user only. */
  wakeSecret: `${prefix}/wake_secret`,
  /** Request `{ sessionId }` → `MemoryStateResult`: the notes in force, the ones waiting for the user's confirmation, problems and the review report. */
  memory: `${prefix}/memory`,
  /** Request `MemoryChangeParams` → `MemoryChangeResult`: the user remembers, retracts, confirms, rejects or renews a note. */
  memoryChange: `${prefix}/memory_change`,
  /** Request `{ sessionId }` or `{ cwd }`, with `builtins?` → `CommandsResult`: the user's and the project's slash commands, the ones a client's own command hides, and the files that could not be used. */
  commands: `${prefix}/commands`,
  /** Request `{ sessionId, name, args, builtins? }` → `ExpandCommandResult`: what `/name args` would send, without sending it. */
  expandCommand: `${prefix}/expand_command`,
  /** Request `CancelCallParams` → `CancelCallResult`: the user stops one running tool call and nothing else; the turn goes on. */
  cancelCall: `${prefix}/cancel_call`,
  /** Request `WatchParams` → `WatchSetResult`: the user sets a watch on the output of a running background command; refused with the engine's sentence. */
  watch: `${prefix}/watch`,
  /** Request `{ sessionId, watchId }` → `{ removed }`: removes a watch that could still fire. */
  unwatch: `${prefix}/unwatch`,
  /** Request `{ sessionId }` → `WatchesResult`: the background commands that are running, each with the watches set on its output. */
  watches: `${prefix}/watches`,
  /** Request `SendCommandParams` → `SendCommandResult`: `/name args` expanded and admitted as the user's message, recorded as that command's (`command.expanded`). Answers once admitted; refused, with the sentence to show, when nothing was sent. */
  sendCommand: `${prefix}/send_command`,
} as const

export const META = {
  /** On `session/prompt`: `"steer"` (the default) or `"queue"`. */
  delivery: `${META_NAMESPACE}/delivery`,
  /** On a `user_message_chunk` whose text a slash command produced: `{ name, arguments, path, scope, missing, unsupported }` (`command.expanded`). */
  command: `${META_NAMESPACE}/command`,
  /** On a settled `tool_call_update`: the harness outcome (`success`, `error`, `not_started`, `effect_unknown`). */
  outcome: `${META_NAMESPACE}/outcome`,
  /** On a settled `tool_call_update` of an edit a language server serves: `ToolDiagnostics`, what the servers said about it. */
  diagnostics: `${META_NAMESPACE}/diagnostics`,
  /** On a settled `tool_call_update`: `HookRun[]`, the hooks that applied to the call, when one refused it, added a note or could not answer. */
  hooks: `${META_NAMESPACE}/hooks`,
  /** On `session/prompt`: the most model calls the turn this prompt starts may make (a whole number of at least 1). */
  maxSteps: `${META_NAMESPACE}/maxSteps`,
  /**
   * The namespace key itself: on `initialize`'s `agentCapabilities._meta`
   * (what this server has) and `clientCapabilities._meta` (`ClientMeta`), on
   * `session/new`, `session/load` and `session/resume` (`OpenMeta`), on
   * `session/close` (`{ shutdown: true }`), on `session/list` (`{ archived: true }`),
   * and in error `data` (`ErrorData`).
   */
  capabilities: META_NAMESPACE,
} as const

/** `clientCapabilities._meta[<ns>]` in `initialize`: what a full-fidelity client asks for. */
export interface ClientMeta {
  /** Send every harness event as `<prefix>/event`, the stored history included on `session/load`. */
  readonly events?: boolean
  /** `false`: send no standard `session/update`s (a client that renders the events itself). Default `true`. */
  readonly updates?: boolean
}

/** `_meta[<ns>]` on `session/new`, `session/load` and `session/resume`. */
export interface OpenMeta {
  /** The model to start with (new) or switch to (load, resume); checked against the account's models first. */
  readonly model?: string | null
  /** The reasoning effort; `null` keeps the default. */
  readonly effort?: string | null
  /**
   * The agent the session runs as, by name; `"none"` is no agent. On
   * `session/new`, absent is the default of the user's configuration; on
   * load and resume it switches the session, and absent keeps what it runs as.
   */
  readonly agent?: string | null
  /** Load and resume: open the session even if it is archived (deleted), as `windlass --session <id>` does. */
  readonly archived?: boolean
  /** The approval mode the user chose for this session: `ask`, `auto` or `full`. The project's file can still only tighten it. */
  readonly approval?: string | null
  /** What a call that would ask becomes when nobody is present: `deny` (refused, the run goes on) or `stop` (refused, the run ends). */
  readonly unattended?: string | null
  /**
   * Whether a person is there to answer `session/request_permission`. Default
   * `true`: an ACP client can answer. A client that runs unattended (a
   * script, an eval) says `false`, and nothing ever waits for it.
   */
  readonly attended?: boolean
  /**
   * Whether this client also answers the questions of the session's
   * subagents (`session/request_permission` with `approval.subagent`).
   * Default: when it is attended. `false`: a subagent's call that would ask
   * is refused, as for nobody present.
   */
  readonly children?: boolean
}

/** The `_meta[<ns>]` of the permission request that asks about a tool call (`APPROVAL_META`). */
export interface ApprovalRequestMeta {
  readonly messageId: string
  readonly callId: string
  /** The harness's question: `title`, `subject` (the command, path or tool, verbatim), `details`, and `choices` with what each remembers. */
  readonly question: unknown
  /** What the question is about. */
  readonly needs: unknown
  /** How the call runs if the answer approves. */
  readonly then: unknown
  /** Set when a subagent of the session asks: the call is the subagent's, and the answer goes to it. */
  readonly subagent?: SubagentRef
}

/** A subagent of a session, as the server names it. */
export interface SubagentRef {
  /** The subagent's own session. */
  readonly sessionId: string
  /** The first line of its task: what to label it with. */
  readonly title: string
  readonly spawnId: string
  /** The parent's `subagent` call that started it (`<message>/<call>`), when this connection saw it start. */
  readonly toolCallId: string | null
}

/** `<prefix>/child`: one durable event of a subagent, as the engine forwards it (`child.event`). */
export interface ChildNotification extends SubagentRef {
  /** The parent session, open on this connection. */
  readonly sessionId: string
  readonly childSessionId: string
  /** The subagent's event as stored in its own log. */
  readonly event: unknown
}

/** Params of `<prefix>/fork`. */
export interface ForkParams {
  readonly sessionId: string
  /** The last event of the parent the fork inherits; must be a step boundary. Default: the latest boundary. */
  readonly throughSeq?: number
  /** `"shared"` (default): the parent's working directory. `{ copyTo? }`: a copy of the workspace of its own (default place under the work directory). */
  readonly workspace?: "shared" | { readonly copyTo?: string }
  /** The fork's model and effort; default the parent's. `effort: null` is the model's default. */
  readonly model?: string
  readonly effort?: string | null
  readonly title?: string | null
}

/** Result of `<prefix>/fork`. */
export interface ForkResult {
  readonly sessionId: string
  /**
   * The session the fork was made from (its lineage). The one named in the
   * request, unless that is a fork itself and `throughSeq` lies in what it
   * inherited: such a point belongs to the session it was forked from (or
   * that one's parent), and the new session is a fork of that session.
   */
  readonly parentSessionId: string
  readonly throughSeq: number
  /** Where the fork works: the parent's directory, or the copy. */
  readonly cwd: string
  /** The directory the copy was made from, when the fork has a copy of its own. */
  readonly copiedFrom: string | null
  readonly title: string | null
  readonly model: string
  readonly effort: string | null
}

/** Params of `<prefix>/replay`: `Engine.replaySession`'s request, and the recording. */
export interface ReplayParams {
  /** The recorded session. */
  readonly sessionId: string
  readonly policy?: "stop" | "execute-read-only" | "execute"
  readonly systemPrompt?: string
  readonly toolDescriptions?: Readonly<Record<string, string>>
  readonly model?: string
  /** `null`: the model's default effort. */
  readonly effort?: string | null
  readonly strict?: boolean
  readonly throughSeq?: number
  /** Where the copy of the workspace is made, for the policies that run tools. */
  readonly workspace?: string
  /** Echoed in `<prefix>/replay_started`, so a client can tell its replays apart. */
  readonly ref?: string
}

/** `<prefix>/replay_started`. */
export interface ReplayStartedNotification {
  /** The replay session: its events follow under this ID. `session/cancel` on it ends the replay as incomplete. */
  readonly sessionId: string
  readonly sourceSessionId: string
  readonly ref: string | null
}

/** Result of `<prefix>/replay`. */
export interface ReplayResult {
  readonly sourceSessionId: string
  readonly sessionId: string
  readonly policy: string
  /** The copy the replay carried on in, or `null` when it ran nothing for real. */
  readonly workspace: string | null
  /** How many model calls the replay made. */
  readonly requests: number
  readonly usage: { readonly inputTokens: number; readonly cachedInputTokens: number; readonly outputTokens: number; readonly reasoningTokens: number } | null
  /** The engine's report (`ReplayReport`): `status` is `identical`, `diverged`, `unsupported` or `incomplete`. */
  readonly report: { readonly status: string; readonly reason: string } & Record<string, unknown>
  /** The report as the harness prints it. */
  readonly text: string
  /** The comparison that carries the signal (`compareReplay`): side effects, the files it ended with, and the grade; `null` when it could not be made. */
  readonly compared: Record<string, unknown> | null
  /** The comparison as the harness prints it (`renderComparison`). */
  readonly comparison: string | null
}

/** Result of `<prefix>/approval`. */
export interface ApprovalStateResult {
  readonly sessionId: string
  /** `false`: this build runs without the approval layer. */
  readonly enabled: boolean
  readonly mode: string | null
  readonly unattended: string | null
  readonly attended: boolean
  /** `null` when commands can be sandboxed; otherwise why not, and what would fix it. */
  readonly sandboxUnavailable: { readonly reason: string; readonly remedy: string | null } | null
  readonly tainted: boolean
  /** One line naming where the untrusted content came from; `null` when the session is not tainted. */
  readonly taint: string | null
  /** Project settings that would have loosened the user's policy and were not followed. */
  readonly ignored: readonly string[]
}

/** `data[<ns>]` of an error the server answers with. */
export interface ErrorData {
  readonly reason:
    | "session_in_use"
    | "session_not_found"
    | "ambiguous_session"
    | "unknown_model"
    /** The model does not take the reasoning effort; `message` names the ones it accepts. */
    | "unknown_effort"
    | "auth_required"
    | "schema_mismatch"
    | "execution_failed"
    /** A failed turn that was ended because a call needed approval and nobody was present (`unattended: "stop"`). */
    | "approval_required"
    | "model_list_failed"
    /** The engine cannot do what was asked as asked (a fork point inside a step, a replay of a recording without a step). */
    | "invalid_request"
    | "closed"
  /** `session_in_use`: the process that holds the session, when it could be told. */
  readonly holderPid?: number | null
  /** The harness's own sentence, without the protocol's prefix. */
  readonly message?: string
  /** `execution_failed`: the provider's error class, when there was one. */
  readonly providerError?: string
}

/** How a turn ended: `<prefix>/turn`, and the `_meta[<ns>]` of the `session/prompt` response. */
export interface TurnNotification {
  readonly sessionId: string
  readonly executionId: string
  /** `unresolved`: done, but the project's checks still fail. */
  readonly outcome: "succeeded" | "unresolved" | "failed" | "interrupted"
  /** The `session/prompt` stop reason, or `"error"` for a failure. */
  readonly stopReason: string
  /** The verification gate's outcome (`execution.succeeded`'s `verification`), when the turn ended as done. */
  readonly verification?: unknown
  /**
   * The stop hooks that still objected when the turn ended: it had been sent back as often as a turn may be
   * (`hooks` on the ending). `objections` is what each of them said that last time, in the order they ran (`text`
   * is empty for a hook that gave no reason): nobody was sent back with it, so it is here for the user.
   */
  readonly hooks?: { readonly unsatisfied: readonly string[]; readonly objections: readonly { readonly hook: string; readonly text: string }[] }
  /** On a failure: why. */
  readonly message?: string
  /** On an interrupt: `user` or `shutdown`. */
  readonly reason?: string
  /** The files the turn changed; `null` on a replay (the list is not stored) or when no snapshot could tell. */
  readonly changedFiles: readonly string[] | null
  /** The turn ended inside a running execution because a queued message was waiting for it. */
  readonly continues?: boolean
  /** Part of a `session/load` replay. */
  readonly replay?: boolean
}

/** Params of `<prefix>/revert` and `<prefix>/undo_revert`. */
export interface RevertParams {
  readonly sessionId: string
  /** `revert` only: the user message to go back before; the latest by default. */
  readonly messageId?: string
  /** Say what would happen and change nothing (`{ kind: "preview", plan }`). */
  readonly dryRun?: boolean
  /**
   * Files edited by hand since that point: `ask` (the default) asks the user
   * with `session/request_permission` when there are any; `abort` changes
   * nothing and answers `hand_edited`; `overwrite` restores them too; `keep`
   * leaves them and restores the rest.
   */
  readonly handEdits?: "ask" | "abort" | "overwrite" | "keep"
}

/** The key under `_meta[<ns>]` of a permission request that asks about a tool call, holding `ApprovalRequestMeta`. */
export const APPROVAL_META = "approval"

/** The options of the hand-edit question (`session/request_permission`). */
export const HAND_EDIT_OPTIONS = { overwrite: "overwrite", keep: "keep", cancel: "cancel" } as const

/** Token counts of one model call, as the harness stores them. */
export interface UsageNotification {
  readonly sessionId: string
  /** The assistant (or compaction) message the call served. */
  readonly messageId: string
  readonly model: string | null
  readonly usage: {
    /** All input tokens, including the cached ones. */
    readonly inputTokens: number
    /** The part of `inputTokens` served from the prompt cache. */
    readonly cachedInputTokens: number
    /** All output tokens, including reasoning tokens. */
    readonly outputTokens: number
    /** The part of `outputTokens` spent on reasoning. */
    readonly reasoningTokens: number
  }
}

export type SessionState = "running" | "idle" | "suspended"

export interface StateNotification {
  readonly sessionId: string
  readonly state: SessionState
  /** On `idle` after work: how it ended, with the same values as `session/prompt`'s `stopReason`, or `"error"`. */
  readonly stopReason?: string
  /** On `idle` after a failure: the failure, as a sentence. */
  readonly message?: string
}

/** Params of `<prefix>/diff`: a turn (`executionId`, the latest by default) or one step (`messageId` of its assistant message). */
export interface DiffParams {
  readonly sessionId: string
  readonly executionId?: string
  readonly messageId?: string
  /** `false`: the list of files without patches. Default `true`. */
  readonly patch?: boolean
}

/** One changed file of a diff. Patches are bounded per file and in total; binary files are flagged and have none. */
export interface DiffFile {
  /** Relative to the session's working directory, `/`-separated. */
  readonly path: string
  readonly status: "added" | "deleted" | "modified" | "mode_changed" | "type_changed"
  readonly binary: boolean
  /** The `diff --git` section of the file (headers and hunks), or `null` (binary, omitted, or patches not asked for). */
  readonly patch: string | null
  /** The patch was cut at a line boundary: the file's change is larger than the per-file limit. */
  readonly truncated: boolean
  /** The total patch budget ran out before this file. */
  readonly omitted: boolean
  readonly added: number
  readonly removed: number
}

/** Result of `<prefix>/diff`. */
export type DiffResult =
  | {
      readonly available: true
      readonly scope: "turn" | "step"
      readonly executionId: string | null
      readonly messageId: string | null
      /** The snapshots compared. */
      readonly from: string
      readonly to: string
      readonly files: readonly DiffFile[]
    }
  | {
      readonly available: false
      /** `not_found`: no such turn or step; `no_snapshots`: none was recorded around it (nothing changed files, or snapshots were off); `unavailable`: the snapshot store cannot be read (gone, pruned, no git). */
      readonly reason: "not_found" | "no_snapshots" | "unavailable"
      readonly message: string
    }

/** One MCP server of a session, as a client shows it. */
export interface McpServerInfo {
  readonly name: string
  /**
   * `running`, `starting`, `failed` (the last attempt failed: `error`, and it is retried in `retryInMs`),
   * `awaiting_approval` (the project's configuration names it and the user has not approved it: `question`),
   * `disabled` (`enabled: false`), `stopped`, or `not_started` (named in a file, not looked at yet: servers start with a turn).
   */
  readonly state: "running" | "starting" | "failed" | "awaiting_approval" | "disabled" | "stopped" | "not_started"
  readonly transport: "stdio" | "http" | null
  /** The command with its arguments, or the address. */
  readonly target: string | null
  /**
   * The command and each of its arguments, one string each, so a client can show where one argument ends
   * (`quotedCommand`). For a question they are the engine's own, of the definition it asks about. `null` for a
   * server reached at an address.
   */
  readonly argv: readonly string[] | null
  /** Tools it offers, once running. */
  readonly tools: number | null
  /** Tools the configuration's allow or deny list hides. */
  readonly hiddenTools: number
  /** Why the last attempt failed or the connection ended, with the end of what it wrote to stderr. */
  readonly error: string | null
  readonly retryInMs: number | null
  /** Which file defines it (`project`: the project's file names or changes it), and its path. */
  readonly origin: "user" | "project" | null
  readonly file: string | null
  /** For `awaiting_approval`: the engine's question, and the fingerprint of exactly this definition, to approve it by. */
  readonly question: { readonly fingerprint: string; readonly subject: string; readonly details: readonly string[] } | null
}

/** Result of `<prefix>/mcp`, and `<prefix>/mcp_changed`. `available: false`: this engine offers no MCP servers. */
export interface McpStateResult {
  readonly sessionId: string
  readonly available: boolean
  readonly servers: readonly McpServerInfo[]
}

/** One hook of a session, as a client shows it. */
export interface HookInfo {
  readonly name: string
  /** When it runs: before a tool call, after one, or when a turn is about to end. */
  readonly point: "beforeTool" | "afterTool" | "stop"
  /**
   * `in_force` (it runs where it applies), `awaiting_approval` (the project's configuration names it and the user
   * has not approved this definition: `question`; it is skipped until then), or `failed` (the last time it ran in
   * this session it could not answer: `error`; it is still run the next time it applies).
   */
  readonly state: "in_force" | "awaiting_approval" | "failed"
  /** The command, word for word. */
  readonly command: string
  /** The tools it applies to (`*` matches any run of characters); `null`: every tool, and always for a stop hook. */
  readonly tools: readonly string[] | null
  /** The path patterns it applies to; `null`: any call. */
  readonly paths: readonly string[] | null
  readonly timeoutSeconds: number
  /** A before hook that cannot answer: `refuse` the call or `allow` it. */
  readonly onError: "refuse" | "allow"
  /** `false`: the user's own hook that asked to run outside the sandbox. */
  readonly sandbox: boolean
  /** Whose file defines it, and its path. */
  readonly origin: "user" | "project"
  readonly file: string | null
  /** Identifies exactly this definition: what `<prefix>/hook_approve` takes. An edited hook has another. */
  readonly fingerprint: string
  /** For `failed`: why it could not answer (timed out, exit code, could not start). */
  readonly error: string | null
  /** For `awaiting_approval`: the engine's question, word for word (the command, what it applies to, how it runs). */
  readonly question: string | null
}

/** Result of `<prefix>/hooks`, and `<prefix>/hooks_changed`. `available: false`: this engine runs no hooks. */
export interface HooksStateResult {
  readonly sessionId: string
  readonly available: boolean
  /** In the order they run: per point the user's first, then the project's. */
  readonly hooks: readonly HookInfo[]
  /** How often per turn stop hooks may send the agent back. */
  readonly maxStopRounds: number
  /** What the project's file asked for beyond what the user's allows, and did not get. */
  readonly ignored: readonly string[]
}

/** One language server of a session, as a client shows it. */
export interface LspServerInfo {
  readonly name: string
  /**
   * `running`, `starting`, `failed` (it could not start or it crashed: `error`; it is started again at a later edit),
   * `awaiting_approval` (the project's configuration names or changes it and the user has not approved it: `question`),
   * `disabled` (`enabled: false`), `stopped`, or `not_started` (a server starts at the first file it serves).
   */
  readonly state: "running" | "starting" | "failed" | "awaiting_approval" | "disabled" | "stopped" | "not_started"
  /** The command with its arguments. */
  readonly command: string
  /** The command and each of its arguments, one string each (`quotedCommand`); for a question, the engine's own, of the definition it asks about. */
  readonly argv: readonly string[]
  /** The files it serves: glob patterns relative to the working directory, by the language they are sent as. */
  readonly languages: readonly { readonly languageId: string; readonly patterns: readonly string[] }[]
  /** One process per workspace root it was started for. */
  readonly processes: readonly { readonly root: string; readonly state: "running" | "starting" | "failed" | "stopped" | "not_started"; readonly error: string | null; readonly restarts: number; readonly openDocuments: number }[]
  /** Why the last start failed or the server ended. */
  readonly error: string | null
  readonly origin: "user" | "project" | null
  readonly file: string | null
  /** For `awaiting_approval`: the engine's question, and the fingerprint of exactly this definition, to approve it by. */
  readonly question: { readonly fingerprint: string; readonly subject: string; readonly details: readonly string[] } | null
}

/** Result of `<prefix>/lsp`, and `<prefix>/lsp_changed`. `available: false`: this engine offers no diagnostics. */
export interface LspStateResult {
  readonly sessionId: string
  readonly available: boolean
  /** Why no edit gets diagnostics although servers are configured (`lsp.enabled: false`, `lsp.waitMs: 0`), as a sentence; else `null`. */
  readonly off: string | null
  /** How long an edit's result may wait for diagnostics, in milliseconds; `null` when nothing is configured. */
  readonly waitMs: number | null
  readonly servers: readonly LspServerInfo[]
}

/** `_meta[<ns>/diagnostics]` of a settled edit: what the language servers said about it (`tool.settled.diagnostics`). */
export interface ToolDiagnostics {
  /** A note with the new diagnostics follows the tool's own output. */
  readonly noteAdded: boolean
  /** New diagnostics the note lists, and the ones it left out. */
  readonly listed: number
  readonly omitted: number
  readonly waitedMs: number
  /** `outcome`: `compared` (with `new` > 0 it made something worse), `unchanged`, `timeout`, `not_running`, `crashed`, `not_approved`, `interrupted`. */
  readonly servers: readonly { readonly name: string; readonly origin: "user" | "project"; readonly outcome: string; readonly new: number; readonly preExisting: number; readonly fixed: number }[]
}

/** One hook that applied to a call or to a turn's ending (`hook.ran`), as a client that does not take the harness's events is told. */
export interface HookRun {
  readonly point: "beforeTool" | "afterTool" | "stop"
  readonly name: string
  readonly origin: "user" | "project"
  /** `yes` (no objection), `no` (it refused the call, added a note, or sent the agent back), `failed`, `interrupted`, `skipped` (not approved). */
  readonly answer: "yes" | "no" | "failed" | "interrupted" | "skipped"
  /** On `failed`: why. */
  readonly failure: string | null
  /** The hook's own text that reached the model: the reason, the note, or the message that sent it back. */
  readonly toModel: string | null
  /** What it printed for the user (its stderr), bounded. */
  readonly forUser: string
}

/** Result of `<prefix>/skills`. */
export interface SkillsResult {
  readonly sessionId: string
  readonly available: boolean
  /** By name. `scope`: `project` (the working directory or a parent), `config` (`skills.paths`) or `user`; `root`: the directory it was found under. */
  readonly skills: readonly { readonly name: string; readonly description: string; readonly path: string; readonly scope: "project" | "config" | "user"; readonly root: string }[]
  /** `skipped`: not loaded, with the reason; `shadowed`: a nearer skill has the name; `warning`: loaded, but something is off. Full paths. */
  readonly problems: readonly { readonly path: string; readonly severity: "skipped" | "shadowed" | "warning"; readonly reason: string }[]
  /** Where skills are looked for, highest precedence first. */
  readonly roots: readonly { readonly dir: string; readonly scope: "project" | "config" | "user" }[]
}

/** One wake-up of a session. `lines` are the engine's own (`describeLines`): state, limits, who created it, the message. */
export interface WakeInfo {
  readonly id: string
  readonly trigger: "at" | "every" | "cron" | "check" | "webhook"
  readonly description: string
  /** `pending`, or how it ended (`completed`, `cancelled`, `expired`, `failed`, ...). */
  readonly state: string
  readonly nextAt: string | null
  readonly fired: number
  readonly maxFirings: number
  readonly author: "user" | "model"
  readonly message: string
  /** A webhook's address. Its secret is never here: `<prefix>/wake_secret`. */
  readonly url: string | null
  readonly lines: readonly string[]
}

/** Result of `<prefix>/wakeups`. `running`: this process fires wake-ups. */
export interface WakeListResult {
  readonly sessionId: string
  readonly available: boolean
  readonly running: boolean
  readonly wakeups: readonly WakeInfo[]
}

/** When a wake-up the user creates fires (`WakeCreateParams.trigger`). Times are milliseconds since the epoch, durations milliseconds. */
export type WakeTrigger =
  | { readonly kind: "at"; readonly at: number }
  | { readonly kind: "after"; readonly delayMs: number }
  | { readonly kind: "every"; readonly intervalMs: number }
  | { readonly kind: "cron"; readonly expression: string; readonly timeZone?: string }
  /** Runs `command` every `intervalMs` without the model: fires the first time it exits 0 (`until`), or each time what it prints or its exit code changes (`on_change`). */
  | { readonly kind: "check"; readonly command: string; readonly intervalMs: number; readonly fire: "until" | "on_change"; readonly timeoutMs?: number; readonly includeOutput?: boolean }
  /** A signed HTTP request to the local listener fires it. */
  | { readonly kind: "webhook"; readonly includeBody?: boolean }

/** How a check's command may run: the most it ever runs with (what the approval layer allows the session's commands when it runs narrows it further). */
export type WakeRun = { readonly kind: "sandboxed"; readonly network: boolean; readonly writableRoots: readonly string[] } | { readonly kind: "unsandboxed" }

/** Params of `<prefix>/wake_create`: a wake-up the user asks for (`Engine.wake().create`). */
export interface WakeCreateParams {
  readonly sessionId: string
  /** What the session is told when it fires. */
  readonly message: string
  readonly trigger: WakeTrigger
  /** `wake` (default) starts a turn if the session is idle; `queue` waits for the next turn. */
  readonly delivery?: "wake" | "queue"
  readonly maxFirings?: number
  /** When it stops at the latest, in milliseconds since the epoch. */
  readonly expiresAt?: number
  readonly minIntervalMs?: number
  /** For a check: the access the user chose for its command. Default: in the sandbox, without network. */
  readonly run?: WakeRun
}

/**
 * Result of `<prefix>/wake_create`. `created: false`: nothing was set up,
 * and `message` is the engine's sentence (the request is not valid, the
 * session cannot have one, it has no room for another). Otherwise `wake`
 * is the wake-up as `<prefix>/wakeups` lists it, and for a webhook `url`
 * and `secret`: the secret is for the user and never the model, and it is
 * in no event, notification or log, only in this answer and
 * `<prefix>/wake_secret`. `running`: this process fires wake-ups.
 */
export interface WakeCreateResult {
  readonly created: boolean
  readonly message: string
  readonly wake: WakeInfo | null
  readonly url: string | null
  readonly secret: string | null
  readonly running: boolean
}

/** Result of `<prefix>/wake_secret`: `secret` and `url`, or `message` saying why there are none. */
export interface WakeSecretResult {
  readonly id: string
  readonly url: string | null
  readonly secret: string | null
  readonly message: string | null
}

/** A note of the session's memory, as a client lists it. */
export interface MemoryNote {
  readonly id: string
  readonly kind: string
  readonly scope: "user" | "project"
  readonly text: string
  /** `active`, `expired (YYYY-MM-DD)`, `superseded by m_...`. */
  readonly state: string
  readonly author: "user" | "model"
  /** The user's words it was derived from, when the model saved it from them. */
  readonly quote: string | null
  readonly created: string
  readonly confirmed: string
  readonly expires: string
}

/** Result of `<prefix>/memory`. `enabled: false`: `off` says why and how to turn it on. */
export interface MemoryStateResult {
  readonly sessionId: string
  readonly enabled: boolean
  readonly off: string | null
  /** With `enabled: false`: memory is on in the configuration and starts with this session's first turn, which has not begun. */
  readonly startsWithFirstTurn?: boolean
  readonly notes: readonly MemoryNote[]
  /** Notes the model saved after untrusted content arrived: not used until the user confirms them. */
  readonly pending: readonly { readonly id: string; readonly scope: string; readonly kind: string; readonly text: string; readonly session: string | null; readonly created: string; readonly quote: string | null; readonly supersedes: string | null; readonly why: string; readonly decisions: readonly string[] }[]
  /** Note files that are not valid and are not used. */
  readonly problems: readonly { readonly path: string; readonly message: string }[]
  /** What a person should look at, most urgent first (`reviewReport`). */
  readonly review: readonly { readonly reason: string; readonly id: string | null; readonly path: string | null; readonly detail: string }[]
  readonly paths: { readonly user: string; readonly project: string | null } | null
}

/** Params of `<prefix>/memory_change`. */
export interface MemoryChangeParams {
  readonly sessionId: string
  readonly action: "remember" | "retract" | "confirm" | "reject" | "renew"
  /** `remember`: the note. */
  readonly text?: string
  /** `remember`: `project` (default) or `user` (about you, for every project). */
  readonly scope?: "user" | "project"
  /** `remember`: default `fact` for the project, `preference` about you. */
  readonly kind?: "preference" | "correction" | "fact" | "pointer"
  /** The note acted on (`m_...`). */
  readonly id?: string
  /** `retract`: why. */
  readonly reason?: string
}

export interface MemoryChangeResult {
  readonly ok: boolean
  /** The note saved or acted on. */
  readonly id: string | null
  /** What happened, or why nothing did, as a sentence. */
  readonly message: string
  /**
   * `remember` only, with `ok: false`: nothing is wrong with the note, but
   * this session's memory starts with its first turn, which has not begun.
   * The client keeps the note and sends it again once the session has
   * started (its `baseline.set` event), so it is never dropped.
   */
  readonly deferred?: boolean
}

/** A command of the client's own, by name and aliases: it wins over a command file of the same name, and counts for a did-you-mean. */
export interface ClientCommand {
  readonly name: string
  readonly aliases?: readonly string[]
}

/** One slash command a file defines (`<prefix>/commands`). */
export interface CommandInfo {
  /** Without the slash: `release-notes`, `frontend:test`. */
  readonly name: string
  readonly description: string
  /** What the file says follows the name (`argument-hint`), for a palette. */
  readonly argumentHint: string | null
  /** The agent the command switches to before its message, when it names one. */
  readonly agent: string | null
  /** The file that defines it. */
  readonly path: string
  /** `project`: from the repository; `config`: a directory the configuration names; `user`: the user's own. */
  readonly scope: "project" | "config" | "user"
  /** The client's own command that takes the name, when one does: the file cannot be run as `/<name>`. */
  readonly hiddenBy: string | null
}

/** Result of `<prefix>/commands`. `available: false`: this engine offers no slash commands. */
export interface CommandsResult {
  readonly available: boolean
  /** By name, hidden ones included. */
  readonly commands: readonly CommandInfo[]
  /** `skipped`: a file that cannot be used, with why; `shadowed`: a nearer file or a client's own command has the name; `warning`: usable, but something in it is not read. */
  readonly problems: readonly { readonly path: string; readonly severity: "skipped" | "shadowed" | "warning"; readonly reason: string; readonly name: string | null }[]
}

/** What expanding a command reported, for the user: on `<prefix>/expand_command`, `<prefix>/send_command`, and (but for `unused`, `appended` and `notes`) in the `command.expanded` event. */
export interface ExpansionReport {
  /** 1-based positions the template uses that were not given: each is empty in the text. */
  readonly missing: readonly number[]
  /** 1-based positions given that the template does not use. */
  readonly unused: readonly number[]
  /** The template has no placeholder: what was typed was appended as a last paragraph. */
  readonly appended: boolean
  /** What another harness would run or read at this point and this one leaves in the text as written, with why. */
  readonly unsupported: readonly { readonly kind: "shell" | "include"; readonly text: string; readonly line: number; readonly reason: string }[]
  /** Anything else worth a line (a quote that was not closed). */
  readonly notes: readonly string[]
}

/** Result of `<prefix>/expand_command`. */
export type ExpandCommandResult =
  /** The text that would be sent as the user's message, and what expansion reported. */
  | ({ readonly kind: "command"; readonly command: CommandInfo; readonly text: string } & ExpansionReport)
  /** The name is a command of the client's own (`builtins`). */
  | { readonly kind: "builtin"; readonly name: string }
  /** A file of that name exists and cannot be used; `message` says why. */
  | { readonly kind: "broken"; readonly name: string; readonly message: string }
  /** No such command; `suggestions` are the close names of both the client's and the files', `message` the sentence to show. */
  | { readonly kind: "unknown"; readonly name: string; readonly suggestions: readonly string[]; readonly message: string }
  /** This engine offers no slash commands. */
  | { readonly kind: "unavailable"; readonly message: string }

/** Params of `<prefix>/send_command`. */
export interface SendCommandParams {
  readonly sessionId: string
  /** The command's name, without the slash. */
  readonly name: string
  /** What was typed after the name. */
  readonly args: string
  /** `steer` (the default) or `queue`, as for a prompt. */
  readonly delivery?: "steer" | "queue"
  readonly maxSteps?: number
  /** The client's own commands: a name one of them takes is refused, and their names count for the did-you-mean. */
  readonly builtins?: readonly ClientCommand[]
}

/** Result of `<prefix>/send_command`: the message admitted, the file it came from, and what expansion reported. */
export interface SendCommandResult extends ExpansionReport {
  readonly messageId: string
  readonly command: CommandInfo
}

/** One agent a session can run as (`<prefix>/agents`). */
export interface AgentInfo {
  readonly name: string
  readonly description: string
  /** The file that defines it. */
  readonly path: string
  /** `project`: from the repository; `config`: a directory the configuration names; `user`: the user's own. */
  readonly scope: "project" | "config" | "user"
  /** The model and effort it runs with; `null`: the session's. */
  readonly model: string | null
  readonly effort: string | null
  /** What it may not do, in a sentence or two (the engine's `describeRestrictions`). */
  readonly restrictions: string
  /** `read only`, `restricted`, or `null` for an agent without restrictions. */
  readonly tag: string | null
}

/** Result of `<prefix>/agents`. `available: false`: this engine offers no agents. */
export interface AgentsResult {
  readonly available: boolean
  /** By name. */
  readonly agents: readonly AgentInfo[]
  /** Definitions that were skipped, are hidden by a nearer one of the same name, or were loaded with a warning; `name` when it could be told. */
  readonly problems: readonly { readonly path: string; readonly severity: "skipped" | "shadowed" | "warning"; readonly reason: string; readonly name: string | null }[]
  /** The agent a new session runs as when none is named (the user's `agents.default`). */
  readonly default: string | null
  /** Settings of the project's file about agents that were not followed. */
  readonly ignored: readonly string[]
  /** With `sessionId`: the agent the session runs as (or will from its next step); `null`: none. */
  readonly current: string | null
}

/**
 * Result of `<prefix>/compact`, the engine's own (`EngineSession.compact`):
 * `compacted` with the sizes the next request was estimated at before and
 * after, `nothing` when there is nothing worth compacting, `failed` when it
 * did not complete; the last two say why in `message`.
 */
export type CompactResult =
  | { readonly kind: "compacted"; readonly tokensBefore: number; readonly tokensAfter: number; readonly source: "model" | "repaired" | "fallback"; readonly detail: string | null }
  | { readonly kind: "nothing"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }

/**
 * A command and its arguments as one line a person can read without
 * guessing where an argument ends: an argument of plain characters as it
 * is, any other in single quotes (a single quote inside as `'\''`), the way
 * a shell would take it back. `bash -c "a b"` given as three arguments reads
 * `bash -c 'a b'`, never `bash -c a b`.
 */
export function quotedCommand(argv: readonly string[]): string {
  return argv.map((argument) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`)).join(" ")
}

/** Params of `<prefix>/cancel_call`. */
export interface CancelCallParams {
  readonly sessionId: string
  /** The call, as `tool.called` names it. */
  readonly callId: string
  /** The step it belongs to (the assistant message), when the client has it: without it the call is looked for in the step in progress. */
  readonly messageId?: string
  /** A subagent of the session whose call it is. */
  readonly childSessionId?: string
}

/**
 * Result of `<prefix>/cancel_call`. `stopped: true`: the request was taken
 * (`tool.cancel_requested` is in the log) and the call settles like any
 * running call: a command with what it had printed and a line that says the
 * user stopped it, a call that cannot be stopped midway (a read, one write)
 * with its ordinary result. `stopped: false`: nothing was asked of the call,
 * and `message` says why in a sentence.
 */
export interface CancelCallResult {
  readonly stopped: boolean
  readonly message: string | null
}

/** Params of `<prefix>/watch`. */
export interface WatchParams {
  readonly sessionId: string
  /** The background command, by its ID (`spawn.started.spawnId`; `<prefix>/watches` lists the running ones). */
  readonly command: string
  /** Text a line must contain, or with `regex` a regular expression (JavaScript's) a line must match. */
  readonly pattern: string
  readonly regex?: boolean
  readonly ignoreCase?: boolean
  /** How often it may fire. Default 1. */
  readonly limit?: number
}

/** Result of `<prefix>/watch`: the watch as it was set (`watch.started`), and how often it fired at once on what the command had already printed. */
export interface WatchSetResult {
  readonly watchId: string
  readonly spawnId: string
  readonly pattern: string
  readonly regex: boolean
  readonly ignoreCase: boolean
  readonly limit: number
  readonly fired: number
}

/** One watch on a running command's output, as `<prefix>/watches` lists it. */
export interface WatchInfo {
  readonly watchId: string
  readonly pattern: string
  readonly regex: boolean
  readonly ignoreCase: boolean
  /** What it looks for, in the engine's words: `text "ready"`, `pattern /error/i`. */
  readonly description: string
  readonly limit: number
  readonly fired: number
  /** Whether it can still fire: it has not fired as often as it may and was not removed. */
  readonly watching: boolean
}

/** Result of `<prefix>/watches`: the session's background commands that are running, oldest first, each with its watches. */
export interface WatchesResult {
  readonly sessionId: string
  readonly commands: readonly { readonly spawnId: string; readonly command: string; readonly logPath: string | null; readonly watches: readonly WatchInfo[] }[]
}

/** A file of a revert plan (`RevertPlan.changes`), as far as the hand-edit question needs it. */
export interface PlannedChange {
  readonly path: string
  readonly handEdited: boolean
  /** Who changed it, as far as the snapshots tell; there exactly when `handEdited`. */
  readonly editedBy?: { readonly kind: "outside" } | { readonly kind: "session"; readonly sessionId: string | null } | { readonly kind: "unknown" }
}

/**
 * The files an undo or a redo asks about before it overwrites them, said
 * with who changed each as far as the engine can tell (`editedBy`), one
 * sentence per answer: by the user or another program while no session
 * worked; while another session worked in the same directory (named, or
 * several); or while a command or the checks of this session ran and no
 * call named the file, which may be the command's own work or the user's
 * meanwhile (`unknown`). `since` is what the change came after (`since the
 * turn`, `since the /undo`). No sentence ends with a full stop.
 */
export function handEditSentences(changes: readonly PlannedChange[], since: string): string[] {
  const groups = new Map<string, string[]>()
  for (const change of changes) {
    if (!change.handEdited) continue
    const by = change.editedBy ?? { kind: "unknown" as const }
    const who =
      by.kind === "outside"
        ? " by you or another program"
        : by.kind === "session"
          ? by.sessionId === null
            ? " while other sessions were working in this directory"
            : ` while session ${by.sessionId} was working in this directory`
          : " while a command or the checks ran (the command's own work, or yours meanwhile)"
    groups.set(who, [...(groups.get(who) ?? []), change.path])
  }
  return [...groups].map(([who, paths]) => `${paths.length === 1 ? "1 file" : `${paths.length} files`} changed ${since}${who}: ${paths.join(", ")}`)
}

/**
 * The title of the question an undo (or, with `redo`, a redo) asks before it overwrites files: how many, and how
 * they changed. Outside this session; or, when every one of them is `unknown`, while a command or the checks of
 * this session ran and no call named them, which may be the session's own work, so "outside this session" would
 * be wrong; or some of each.
 */
export function handEditTitle(changes: readonly PlannedChange[], redo: boolean): string {
  const asked = changes.filter((change) => change.handEdited)
  const during = asked.filter((change) => (change.editedBy?.kind ?? "unknown") === "unknown").length
  const how = during === 0 ? "changed outside this session" : during === asked.length ? "changed while a command ran" : "changed outside this session or while a command ran"
  return `${redo ? "Redo" : "Undo"}: ${asked.length === 1 ? "1 file" : `${asked.length} files`} ${how} ${redo ? "since the undo" : "since the turn"}`
}

/** One item of the model's task list (the `todo` tool). */
export interface TaskItem {
  readonly text: string
  readonly status: "pending" | "in_progress" | "done"
}

/** The longest derived title, in characters. */
export const TITLE_LENGTH = 60

/**
 * A session's title when it has none of its own: the first line of its first
 * message, trimmed, with runs of spaces collapsed, shortened at a word
 * boundary to `TITLE_LENGTH` characters. Deterministic and free: no model call.
 * `null` for a message with no text.
 */
export function deriveTitle(message: string): string | null {
  const line = message
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part !== "")
  if (line === undefined) return null
  if (line.length <= TITLE_LENGTH) return line
  const cut = line.slice(0, TITLE_LENGTH - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space >= TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`
}

/** A session's title: its own, or else derived from the beginning of the first thing the user said in it (`SessionSummary.firstPrompt`). */
export function sessionTitle(own: string | null, firstPrompt: string | null): string | null {
  if (own !== null && own.trim() !== "") return own
  return firstPrompt === null ? null : deriveTitle(firstPrompt)
}

/** The derived title of a session from the start of its log: its first message from the user (`deriveTitle`), or `null`. */
export function titleFromEvents(events: readonly { readonly type: string; readonly data?: unknown }[]): string | null {
  for (const item of events) {
    if (item.type !== "inbox.enqueued") continue
    const data = item.data as { origin?: unknown; content?: readonly { type: string; text?: string }[] }
    if (data.origin !== null) continue
    return deriveTitle((data.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""))
  }
  return null
}
