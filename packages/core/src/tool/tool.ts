/**
 * The tool contract. The runtime that validates input, runs tools in parallel
 * and caps output belongs to the tool track; this file fixes only what a tool
 * is, what it is given and what it returns.
 */
import type { BlobRef } from "../content.ts"
import type { CallId, MessageId, SessionId } from "../id.ts"
import type { Json } from "../json.ts"
import { type Infer, integer, json, nonEmptyString, nullable, object, oneOf, string } from "../validate.ts"

/**
 * What the model is told about a tool. This is the part that enters the
 * request, is hashed as a `tool` block and is frozen in the session baseline.
 * `inputSchema` is a JSON Schema object describing the tool's input.
 */
export const toolSpec = object({ name: nonEmptyString, description: string, inputSchema: json })
export type ToolSpec = Infer<typeof toolSpec>

/**
 * The strongest thing a tool can do. Sandbox and approval decisions are made
 * from this class, never from the tool's name.
 * - `read`: observes the workspace; no side effect.
 * - `write`: changes files in the workspace.
 * - `exec`: runs arbitrary processes.
 * - `network`: talks to something outside the machine.
 *
 * A call that was started with any effect other than `read` and whose outcome
 * was not observed is settled as `effect_unknown`.
 */
export const toolEffect = oneOf(["read", "write", "exec", "network"])
export type ToolEffect = Infer<typeof toolEffect>

/** Recorded when the model-facing output is shorter than what the tool produced. */
export const truncation = object({
  /** Size of the full output before capping. */
  originalBytes: integer(0),
  originalLines: integer(0),
  /** Where the full output was written, when it was spilled to a file. */
  spillPath: nullable(string),
})
export type Truncation = Infer<typeof truncation>

/** Ephemeral progress from a running tool, for display only. It is never stored and never sent to the model. */
export interface ToolProgress {
  /** Replaces the previous progress text for this call, e.g. the tail of a running command's output. */
  readonly text: string
}

/** Everything a tool is given besides its input. */
export interface ToolContext {
  readonly sessionId: SessionId
  /** The assistant message that made the call. With `callId` it identifies the call. */
  readonly messageId: MessageId
  /** The provider's call ID. Not unique on its own. */
  readonly callId: CallId
  /** Absolute working directory of the session. Relative paths in the input resolve against it. */
  readonly cwd: string
  /**
   * Aborted when the execution is interrupted. Created by `createInterrupt`, so
   * `interruptReasonOf(signal)` gives the reason. A tool must stop promptly and
   * return what it observed so far rather than throw (a shell kills its process
   * group, waits a bounded grace period, then returns the output so far).
   */
  readonly signal: AbortSignal
  /** Reports ephemeral progress. Safe to call often; may be dropped. */
  readonly progress: (update: ToolProgress) => void
}

/**
 * What a tool returns. The runtime turns it into the `tool.settled` event
 * exactly once; from then on `output` is stored and replayed byte for byte and
 * nothing may re-render or re-cap it (storage rule 4).
 */
export interface ToolResult {
  /** `error` means the tool ran and failed; the model sees `output` as the error text. */
  readonly status: "success" | "error"
  /**
   * The text for the model. If the tool capped it itself (for example a shell
   * that kept only a head and tail while streaming to a spill file), it says so
   * in `truncation` and the runtime must not cap again. If `truncation` is
   * `null`, the runtime applies its cap once and fills `truncation` in.
   */
  readonly output: string
  readonly truncation: Truncation | null
  /** Media for the model, already stored in the blob table. */
  readonly attachments: readonly BlobRef[]
  /** Structured data for a UI (a diff, an exit code). Never sent to the model. */
  readonly display: Json | null
}

/**
 * A tool. `Input` is the shape `execute` receives after the runtime has
 * validated the model's arguments against `inputSchema`; malformed or
 * truncated arguments never reach `execute` (retry rule 6).
 */
export interface Tool<Input = Json> extends ToolSpec {
  readonly effect: ToolEffect
  /**
   * Runs the tool. Expected failures are returned as `status: "error"`. A
   * thrown exception is a bug in the tool; the runtime settles the call as
   * `error`, or as `effect_unknown` when `effect` is not `read`.
   */
  readonly execute: (input: Input, context: ToolContext) => Promise<ToolResult>
}

/**
 * A tool of any input type, for registries and the runtime. `Tool<{ path: string }>`
 * is assignable to it. The runtime validates the model's arguments against
 * `inputSchema` and then makes the one cast needed to call `execute`.
 */
export type AnyTool = Tool<never>

/** Extracts the model-facing part of a tool. */
export function specOf(tool: ToolSpec): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

/**
 * Orders tools by name, comparing UTF-16 code units. The order is the same on
 * every machine and locale (`localeCompare` is not), which the frozen tool list
 * depends on (context rule 2).
 */
export function sortTools<T extends { readonly name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
