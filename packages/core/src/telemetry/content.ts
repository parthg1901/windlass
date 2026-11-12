/**
 * Text that leaves the machine only when content export is asked for: the
 * same credential redaction the harness applies to tool results
 * (`approval/redact.ts`, with the values of credential-looking environment
 * variables), then a size bound. Redaction runs first, so a bound never cuts
 * a secret in half and leaves the other half readable.
 */
import { redact } from "../approval/redact.ts"
import { isCredentialName } from "../sandbox/policy.ts"

/** Characters one content attribute (or one part of a message) may hold. */
export const DEFAULT_MAX_CONTENT_CHARS = 4096
/** Parts one exported message list may hold; the rest are counted, not sent. */
export const MAX_PARTS = 32

/** The values of the process's credential-looking environment variables, as the engine collects its own `secrets`. */
export function credentialValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return [...new Set(Object.entries(env).flatMap(([name, value]) => (value !== undefined && value !== "" && isCredentialName(name) ? [value] : [])))]
}

/** Redacts, then bounds. The marker at the end says how much was left out. */
export function boundedText(text: string, secrets: readonly string[], maxChars: number): string {
  const clean = redact(text, secrets).text
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, maxChars)}…[truncated ${clean.length - maxChars} chars]`
}

/** One part of a message in the shape the GenAI conventions give `gen_ai.input.messages` and `gen_ai.output.messages`. */
export type MessagePart =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "blob"; readonly mime_type: string }

export interface ConventionMessage {
  readonly role: "user" | "assistant" | "system"
  readonly parts: readonly MessagePart[]
  readonly finish_reason?: string
}

/** The JSON text of a message list, with every text bounded and at most `MAX_PARTS` parts per message. */
export function messagesJson(messages: readonly ConventionMessage[], secrets: readonly string[], maxChars: number): string {
  const bounded = messages.map((message) => {
    const parts = message.parts.slice(0, MAX_PARTS).map((part): MessagePart => {
      if (part.type === "text") return { type: "text", content: boundedText(part.content, secrets, maxChars) }
      if (part.type === "tool_call") return { ...part, arguments: boundedText(part.arguments, secrets, maxChars) }
      return part
    })
    const omitted = message.parts.length - parts.length
    return { ...message, parts: omitted > 0 ? [...parts, { type: "text" as const, content: `…[${omitted} more parts]` }] : parts }
  })
  return JSON.stringify(bounded)
}
