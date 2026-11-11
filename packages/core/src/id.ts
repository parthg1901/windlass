/**
 * Identifier types. They are branded so a message ID cannot be passed where a
 * session ID is expected. IDs carry no ordering: the per-session `seq` is the
 * only order (storage rule 1).
 */
import { randomBytes } from "node:crypto"
import { branded } from "./validate.ts"

export type SessionId = string & { readonly __id: "session" }

/**
 * Identifies one projected message. For a user or synthetic message that came
 * through the inbox it is also the inbox item's ID, chosen at enqueue time. For
 * an assistant message it identifies one step attempt that produced output.
 */
export type MessageId = string & { readonly __id: "message" }

/** Identifies one busy period of a session, from the write-ahead claim to its terminal event. */
export type ExecutionId = string & { readonly __id: "execution" }

/** Identifies one model call in the request ledger. */
export type RequestId = string & { readonly __id: "request" }

/**
 * The provider's tool-call ID, exactly as received. Providers reuse these
 * across steps, so it is unique only together with the assistant message that
 * made the call: always key tool calls by `(MessageId, CallId)`.
 */
export type CallId = string & { readonly __id: "call" }

export const sessionId = branded<SessionId>()
export const messageId = branded<MessageId>()
export const executionId = branded<ExecutionId>()
export const requestId = branded<RequestId>()
export const callId = branded<CallId>()

const prefixes = { session: "ses", message: "msg", execution: "exe", request: "req" } as const

type Generated = { session: SessionId; message: MessageId; execution: ExecutionId; request: RequestId }

/** Generates a random ID such as `msg_3f9a…`. Call IDs come from the provider and are never generated here. */
export function newId<K extends keyof Generated>(kind: K): Generated[K] {
  return `${prefixes[kind]}_${randomBytes(12).toString("hex")}` as Generated[K]
}
