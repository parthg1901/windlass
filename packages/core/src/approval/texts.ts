/**
 * The texts the model sees when a call did not run as asked, and the phrases
 * questions are built from. Short and factual: they say what happened and
 * what would be needed, nothing more.
 */
import { brand } from "../brand.ts"
import type { Need } from "./grants.ts"

/** Refused by the policy, before anyone was asked. */
export function deniedMessage(reason: string): string {
  return `Not run: ${reason}.`
}

/** The call needed approval and no one was present (a script, an eval, a scheduled run). */
export function unattendedMessage(needs: readonly Need[]): string {
  return `Not run: this call needs the user's approval for ${listOf(needs.map(describeNeed))}, and this run has no one to approve it.`
}

/** The user was asked and said no. */
export function declinedMessage(note: string | null): string {
  const text = note?.trim() ?? ""
  return text === "" ? "Not run: the user declined this call." : `Not run: the user declined this call. Their note: ${text}`
}

/** Put before the tool's output when the user approved with a note. */
export function approvedNote(note: string): string {
  return `The user approved this call with a note: ${note.trim()}`
}

/** What a need is, as part of a sentence. */
export function describeNeed(need: Need): string {
  if (need.kind === "exec-sandboxed") return "running a command"
  if (need.kind === "exec-unsandboxed") return "running a command without the sandbox"
  if (need.kind === "sandbox-network") return "network access for this command"
  if (need.kind === "sandbox-write") return `this command writing to ${need.path}`
  if (need.kind === "write") return need.path === null ? "writing files" : `writing ${need.path}`
  if (need.kind === "read-hidden") return `reading ${need.path}`
  if (need.kind === "records") return `changing ${brand.name}'s own records`
  return `using ${need.tool}`
}

/** What remembering a need stores, as part of a sentence. */
export function describeRemembered(need: Need): string {
  if (need.kind === "exec-sandboxed") return "commands in the sandbox"
  if (need.kind === "exec-unsandboxed") return "commands without the sandbox"
  if (need.kind === "sandbox-network") return "network for sandboxed commands"
  if (need.kind === "sandbox-write") return `writes by sandboxed commands under ${need.path}`
  if (need.kind === "write") return `writes by file tools under ${need.root}`
  if (need.kind === "read-hidden") return `reading ${need.path}`
  if (need.kind === "records") return `${need.tool} changing ${brand.name}'s own records`
  return `the tool ${need.tool}`
}

export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}
