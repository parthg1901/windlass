/**
 * Trust. Memory is a way for content to outlive the session it came from, so
 * text the harness does not control (a web page, an MCP server's result, a
 * file in a dependency) could use it to plant instructions in every later
 * session. The rule:
 *
 * - The caller says whether the session has taken in untrusted content (a
 *   flag; deciding it is the safety layer's job). A note the model saves after
 *   that point is stored with `untrusted: yes` and `status: pending`.
 * - A pending note is never delivered, never counts as a duplicate to merge
 *   into, and supersedes nothing. It is shown to the user, who confirms it
 *   (it becomes active, with `user-confirmed`) or rejects it (`rejected`,
 *   kept on disk). Editing the file to `status: active` by hand is the same
 *   confirmation.
 * - In such a session the model cannot retract or replace a note; it is told
 *   to ask the user, who can.
 * - Whatever its origin, a note is shown to the model as a recalled note with
 *   who wrote it and when, inside a block that says notes are not
 *   instructions (`deliver.ts`); a confirmed untrusted note says so as well.
 *
 * Everything here is data and pure functions; the store applies the results.
 */
import { type MemoryEntry, isoSeconds, oneLine } from "./entry.ts"

export interface Admission {
  readonly status: "active" | "pending"
  readonly untrusted: boolean
}

/** How a new note enters the store. The user's own note is always trusted. */
export function admission(author: "user" | "model", sessionUntrusted: boolean): Admission {
  if (author === "model" && sessionUntrusted) return { status: "pending", untrusted: true }
  return { status: "active", untrusted: false }
}

/** Whether the model may retract or replace notes in this session. */
export function mayModelRetract(sessionUntrusted: boolean): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (!sessionUntrusted) return { ok: true }
  return {
    ok: false,
    reason:
      "Memory notes cannot be retracted or replaced from this session, because it has taken in content from outside the conversation. Tell the user which note is wrong and why; they can retract it themselves.",
  }
}

export type Decision = "confirm" | "reject"

/** What a client shows the user for one pending note. */
export interface ConfirmationRequest {
  readonly id: string
  readonly scope: MemoryEntry["scope"]
  readonly kind: MemoryEntry["kind"]
  readonly text: string
  readonly session: string | null
  readonly created: string
  readonly quote: string | null
  readonly supersedes: string | null
  readonly why: string
  readonly decisions: readonly Decision[]
}

export function confirmationRequests(entries: readonly MemoryEntry[]): ConfirmationRequest[] {
  return entries
    .filter((entry) => entry.status === "pending")
    .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1))
    .map((entry) => ({
      id: entry.id,
      scope: entry.scope,
      kind: entry.kind,
      text: oneLine(entry.text),
      session: entry.provenance.session,
      created: entry.created,
      quote: entry.provenance.quote,
      supersedes: entry.supersedes,
      why: "The assistant saved this after the session had taken in content from outside the conversation (a web page, a tool server, a file it did not write). Such content can try to plant instructions, so the note is not used until you confirm it.",
      decisions: ["confirm", "reject"] as const,
    }))
}

/** The text a terminal shows for the pending notes, or `null` when there are none. */
export function renderConfirmationRequests(requests: readonly ConfirmationRequest[]): string | null {
  if (requests.length === 0) return null
  const lines = requests.flatMap((request) => [
    `[${request.id}] ${request.scope} ${request.kind}: ${request.text}`,
    `    saved ${request.created.slice(0, 10)} in session ${request.session ?? "?"}${request.quote === null ? "" : `, from your words "${request.quote}"`}${request.supersedes === null ? "" : `, replacing ${request.supersedes}`}`,
  ])
  return [`${requests.length === 1 ? "1 memory note waits" : `${requests.length} memory notes wait`} for your confirmation. ${requests[0]!.why}`, ...lines].join("\n")
}

/** The entry after the user's decision on it. Throws if it is not pending: there is nothing to decide. */
export function applyDecision(entry: MemoryEntry, decision: Decision, now: Date): MemoryEntry {
  if (entry.status !== "pending") throw new Error(`${entry.id} is ${entry.status}, not pending`)
  const at = isoSeconds(now)
  if (decision === "reject") return { ...entry, status: "rejected" }
  // Confirming is also confirming that it is true now, so the expiry period starts again.
  return { ...entry, status: "active", userConfirmed: at, confirmed: at }
}
