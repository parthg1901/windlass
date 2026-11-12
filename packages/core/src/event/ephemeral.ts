/**
 * Ephemeral events: progress that is shown live and never stored (storage
 * rule 3). They have no `seq`. A client that misses them loses nothing,
 * because the durable event that ends each item carries the complete value.
 *
 * Within one assistant message, text and reasoning stream one item at a time,
 * so a client keeps one text buffer and one reasoning buffer per message and
 * clears each when the matching `text.ended` or `reasoning.ended` arrives.
 * Tool-call input and tool progress are told apart by `callId`.
 */
import type { CallId, MessageId, SessionId } from "../id.ts"
import type { EventType, StoredEvent } from "./durable.ts"

export type EphemeralEvent =
  /** More of the text the model is writing. */
  | { readonly type: "text.delta"; readonly sessionId: SessionId; readonly messageId: MessageId; readonly text: string }
  /** More of the reasoning summary the model is writing. */
  | {
      readonly type: "reasoning.delta"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly text: string
    }
  /** More of a tool call's argument text. The call does not exist durably until `tool.called`. */
  | {
      readonly type: "tool.input.delta"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly callId: CallId
      readonly name: string
      readonly input: string
    }
  /** Progress from a running tool. `text` replaces the previous progress text of the call. */
  | {
      readonly type: "tool.progress"
      readonly sessionId: SessionId
      readonly messageId: MessageId
      readonly callId: CallId
      readonly text: string
    }

  /** Progress from a running check: the tail of its output so far. `text` replaces the previous progress text of the check. */
  | { readonly type: "checks.progress"; readonly sessionId: SessionId; readonly run: number; readonly check: string; readonly text: string }
  /**
   * The files the execution that is about to end changed: what differs
   * between the snapshot taken when its first input arrived (`from`) and the
   * latest one (`to`). Derived from the durable snapshot IDs, for display.
   */
  | { readonly type: "workspace.changes"; readonly sessionId: SessionId; readonly from: string; readonly to: string; readonly files: readonly string[] }
  /**
   * Something the engine noticed about this session that is not part of its
   * log: a request that broke the cached prefix with no event that allows it,
   * a tool or a listener that threw, an internal error.
   */
  | {
      readonly type: "diagnostic"
      readonly sessionId: SessionId
      readonly kind: "prefix_violation" | "internal_error" | "tool_crashed" | "listener_failed" | "skills" | "mcp" | "wake" | "memory" | "agents" | "hooks" | "lsp" | "telemetry" | "history" | "watch"
      readonly message: string
    }
  /**
   * Something about how the session's tools run that the user should read
   * once: the sandbox is unavailable on this machine (and why, and what
   * would fix it), a project file asked for a looser approval policy than
   * the user's and was not followed, the project's checks were not run
   * because they could not be sandboxed. Or about how a turn ended:
   * `no_closing_answer` when the model did its work and then returned
   * nothing twice, so the turn ended without a last word from it.
   */
  | {
      readonly type: "notice"
      readonly sessionId: SessionId
      readonly kind: "sandbox_unavailable" | "approval_ignored" | "checks_not_run" | "no_closing_answer"
      readonly message: string
    }

  /**
   * Something happened in a subagent of this session: `event` is a durable
   * event of the child session `child`, as that session recorded it (its
   * `sessionId` is the child's). A client shows the child's activity from
   * these, compactly, and an `approval.requested` among them is a question
   * of the child's to put to the user, labelled with `title`. Not stored
   * here: the child's own log is the record.
   */
  | {
      readonly type: "child.event"
      readonly sessionId: SessionId
      readonly child: SessionId
      readonly spawnId: string
      /** The first line of the child's task. */
      readonly title: string
      readonly event: StoredEvent
    }

export type EphemeralEventType = EphemeralEvent["type"]

/** Compile-time check that no ephemeral type name is also a durable one. */
type Disjoint = Extract<EphemeralEventType, EventType> extends never ? true : never
export const EPHEMERAL_NAMES_ARE_DISJOINT: Disjoint = true
