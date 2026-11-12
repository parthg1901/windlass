/**
 * A scripted model for running the real `acp` subcommand in tests without a
 * network or a sign-in. When the environment variable `SCRIPT_ENV` names a
 * JSON file, the server uses a `FakeProvider` that plays it: one response per
 * model call, each a list of items.
 *
 *   { "responses": [
 *       [{ "type": "reasoning", "text": "Look first." }, { "type": "tool_call", "callId": "c1", "name": "ls", "input": {} }],
 *       [{ "type": "text", "text": "Done." }, { "type": "usage", "inputTokens": 120, "cachedInputTokens": 100, "outputTokens": 8 }]
 *   ] }
 *
 * Items: `text` and `reasoning` (`text`), `tool_call` (`callId`, `name`,
 * `input`), `usage` (token counts), `delay` (`ms`), `finish` (`reason`), and
 * `fail` (`kind`, `message`). It is a testing aid and is never used otherwise.
 */
import { brand } from "@light-harness/core"
import { FakeProvider, type ScriptItem, script } from "@light-harness/core/testing"

export const SCRIPT_ENV = `${brand.envPrefix}ACP_SCRIPT`

type RawItem = Record<string, unknown>

export async function scriptedProvider(path: string): Promise<FakeProvider> {
  const parsed: unknown = await Bun.file(path).json()
  const responses = (parsed as { responses?: unknown }).responses
  if (!Array.isArray(responses)) throw new Error(`${path}: expected { "responses": [[item, ...], ...] }`)
  return new FakeProvider(responses.map((response, index) => toResponse(response, index)))
}

function toResponse(response: unknown, index: number): ScriptItem[] {
  if (!Array.isArray(response)) throw new Error(`response ${index} is not a list of items`)
  return response.map((item: RawItem) => {
    switch (item.type) {
      case "text":
        return script.text(String(item.text ?? ""))
      case "reasoning":
        return script.reasoning(String(item.text ?? ""))
      case "tool_call":
        return script.toolCall(String(item.callId), String(item.name), (item.input ?? {}) as never)
      case "usage":
        return script.usage({
          inputTokens: Number(item.inputTokens ?? 0),
          cachedInputTokens: Number(item.cachedInputTokens ?? 0),
          outputTokens: Number(item.outputTokens ?? 0),
          reasoningTokens: Number(item.reasoningTokens ?? 0),
        })
      case "delay":
        return script.delay(Number(item.ms ?? 0))
      case "finish":
        return script.finish(item.reason as "stop" | "tool_calls" | "length")
      case "fail":
        return script.fail(item.kind as never, { message: String(item.message ?? "scripted failure") })
      default:
        throw new Error(`response ${index}: unknown item type ${String(item.type)}`)
    }
  })
}
