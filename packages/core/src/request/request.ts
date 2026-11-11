/**
 * The provider-neutral model request. The request builder produces it as a
 * pure function of stored rows; a provider turns it into wire bytes.
 *
 * A request is also viewable as an ordered list of blocks (`requestBlocks`).
 * Blocks are what the request ledger hashes, and the order is the order in
 * which a change invalidates the provider's prompt cache: parameters, then
 * each tool, then the instructions, then each input item.
 */
import { type BlobRef, type Content } from "../content.ts"
import type { Json } from "../json.ts"
import type { ToolSpec } from "../tool/tool.ts"

/** Settings of the call that are not content. Any difference here is reported as a `params` change. */
export interface RequestParams {
  readonly model: string
  /** Provider-interpreted effort level such as `"low"` or `"high"`; `null` uses the model's default. */
  readonly reasoningEffort: string | null
  /** `none` forbids tool calls for this call while keeping the tool list (and the cache prefix) unchanged. */
  readonly toolChoice: "auto" | "none"
  readonly parallelToolCalls: boolean
}

/**
 * One item of model input, in history order.
 *
 * `providerData` is an opaque payload the provider attached to its own output
 * (encrypted reasoning, item phase). It is stored as received and must be sent
 * back verbatim; nothing but the provider that produced it may look inside.
 */
export type InputItem =
  /** Something said to the model. `developer` carries harness instructions; there is no `system` role. */
  | { readonly type: "message"; readonly role: "user" | "developer"; readonly content: Content }
  /** Text the model produced. */
  | { readonly type: "assistant_text"; readonly text: string; readonly providerData: Json | null }
  /** Reasoning the model produced. `text` is the readable summary, possibly empty. */
  | { readonly type: "reasoning"; readonly text: string; readonly providerData: Json | null }
  /** A tool call the model made. `input` is the argument text exactly as the model produced it. */
  | {
      readonly type: "tool_call"
      readonly callId: string
      readonly name: string
      readonly input: string
      readonly providerData: Json | null
    }
  /** The one terminal result of a tool call, exactly as stored when the call settled. */
  | {
      readonly type: "tool_result"
      readonly callId: string
      readonly output: string
      readonly attachments: readonly BlobRef[]
    }

export interface ModelRequest {
  readonly params: RequestParams
  /** In wire order. The request builder sorts them once with `sortTools` and never reorders. */
  readonly tools: readonly ToolSpec[]
  /** The frozen baseline instructions (the system prompt). */
  readonly instructions: string
  readonly input: readonly InputItem[]
}

export type RequestBlock =
  | { readonly kind: "params"; readonly params: RequestParams }
  | { readonly kind: "tool"; readonly tool: ToolSpec }
  | { readonly kind: "instructions"; readonly text: string }
  | { readonly kind: "input"; readonly item: InputItem }

export type BlockKind = RequestBlock["kind"]

/** Block kinds in request order. A block of a later kind never precedes one of an earlier kind. */
export const BLOCK_KINDS = ["params", "tool", "instructions", "input"] as const satisfies readonly BlockKind[]

/** The ordered block view of a request: `params`, each tool, `instructions`, each input item. */
export function requestBlocks(request: ModelRequest): RequestBlock[] {
  return [
    { kind: "params", params: request.params },
    ...request.tools.map((tool): RequestBlock => ({ kind: "tool", tool })),
    { kind: "instructions", text: request.instructions },
    ...request.input.map((item): RequestBlock => ({ kind: "input", item })),
  ]
}

/**
 * The inverse of `requestBlocks`. Throws when the list is not one `params`
 * block, then tools, then one `instructions` block, then input items.
 */
export function requestFromBlocks(blocks: readonly RequestBlock[]): ModelRequest {
  const order = blocks.map((block) => BLOCK_KINDS.indexOf(block.kind))
  if (order.some((rank, index) => index > 0 && rank < order[index - 1]!))
    throw new Error("request blocks are out of order; expected params, tools, instructions, input")
  const params = blocks.filter((block) => block.kind === "params")
  const instructions = blocks.filter((block) => block.kind === "instructions")
  if (params.length !== 1 || instructions.length !== 1)
    throw new Error("a request has exactly one params block and exactly one instructions block")
  return {
    params: params[0]!.params,
    tools: blocks.filter((block) => block.kind === "tool").map((block) => block.tool),
    instructions: instructions[0]!.text,
    input: blocks.filter((block) => block.kind === "input").map((block) => block.item),
  }
}
