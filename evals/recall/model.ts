/**
 * The one way the evaluation calls a model: an injected function. Tests pass
 * a scripted fake; `--live` passes `liveModel()`, which uses the harness's
 * Responses provider with the saved ChatGPT sign-in.
 *
 * Nothing here prints, logs or writes the access token or any header; the
 * provider alone puts the token in the Authorization header.
 */
import type { Usage } from "../../packages/core/src/provider/usage.ts"
import type { InputItem, ModelRequest } from "../../packages/core/src/request/request.ts"

export interface ModelCall {
  readonly callId: string
  readonly name: string
  readonly input: string
}

export interface ModelReply {
  readonly text: string
  readonly calls: readonly ModelCall[]
  /** The response as input items, to replay in a follow-up request. */
  readonly output: readonly InputItem[]
  readonly usage: Usage | null
  /** Set when the call failed; `text` is then empty. */
  readonly error: string | null
}

export type ModelFn = (request: ModelRequest) => Promise<ModelReply>

export const LIVE_MODEL = "gpt-6-luna"
export const LIVE_EFFORT = "low"

/** Counts requests and refuses to go past `limit`, so a bug cannot spend more than the budget. */
export function capped(model: ModelFn, limit: number): ModelFn & { readonly used: () => number } {
  let used = 0
  const wrapped = async (request: ModelRequest) => {
    if (used >= limit) throw new Error(`request budget of ${limit} spent; stopping`)
    used += 1
    return model(request)
  }
  return Object.assign(wrapped, { used: () => used })
}

/** The real provider. Imported lazily so tests never load the sign-in code. */
export async function liveModel(): Promise<ModelFn> {
  const { RESOURCE, accessToken } = await import("../../packages/core/src/auth/chatgpt.ts")
  const { OpenAIResponsesProvider } = await import("../../packages/core/src/provider/openai-responses.ts")
  const provider = new OpenAIResponsesProvider({
    accessToken,
    baseUrl: RESOURCE,
    readBlob: () => {
      throw new Error("no media in the recall evaluation")
    },
  })
  return async (request) => {
    const output: InputItem[] = []
    const calls: ModelCall[] = []
    let text = ""
    let usage: Usage | null = null
    let error: string | null = null
    for await (const event of provider.stream(request, new AbortController().signal)) {
      if (event.type === "text.end") {
        text += event.text
        output.push({ type: "assistant_text", text: event.text, providerData: event.providerData })
      }
      if (event.type === "reasoning.end") output.push({ type: "reasoning", text: event.text, providerData: event.providerData })
      if (event.type === "tool_call.end") {
        calls.push({ callId: event.callId, name: event.name, input: event.input })
        output.push({ type: "tool_call", callId: event.callId, name: event.name, input: event.input, providerData: event.providerData })
      }
      if (event.type === "usage") usage = event.usage
      if (event.type === "error") error = `${event.error.kind}: ${event.error.message}`
    }
    // A reasoning item may not end a replayed response; drop trailing ones.
    while (output.length > 0 && output[output.length - 1]!.type === "reasoning") output.pop()
    return { text, calls, output, usage, error }
  }
}
