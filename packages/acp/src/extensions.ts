/**
 * The harness features ACP v1 has no shape for, exposed as extension methods
 * and notifications. Every name is built from `brand.extensionPrefix` (a
 * leading underscore marks an ACP extension); `_meta` keys use the same name
 * without the underscore, as ACP's extensibility rules ask.
 */
import { brand } from "@light-harness/core"

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
} as const

export const META = {
  /** On `session/prompt`: `"steer"` (the default) or `"queue"`. */
  delivery: `${META_NAMESPACE}/delivery`,
  /** On a settled `tool_call_update`: the harness outcome (`success`, `error`, `not_started`, `effect_unknown`). */
  outcome: `${META_NAMESPACE}/outcome`,
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
  /** Load and resume: open the session even if it is archived (deleted), as `lh --session <id>` does. */
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
    | "auth_required"
    | "schema_mismatch"
    | "execution_failed"
    /** A failed turn that was ended because a call needed approval and nobody was present (`unattended: "stop"`). */
    | "approval_required"
    | "model_list_failed"
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
