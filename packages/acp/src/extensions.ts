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
} as const

export const META = {
  /** On `session/prompt`: `"steer"` (the default) or `"queue"`. */
  delivery: `${META_NAMESPACE}/delivery`,
  /** On a settled `tool_call_update`: the harness outcome (`success`, `error`, `not_started`, `effect_unknown`). */
  outcome: `${META_NAMESPACE}/outcome`,
  /** On `initialize`'s `agentCapabilities._meta`: the extension methods and notifications this server has. */
  capabilities: META_NAMESPACE,
} as const

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
