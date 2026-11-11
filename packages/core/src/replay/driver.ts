/**
 * A replay driver that needs no step loop: for tests, and as a reference for
 * the loop's author, who replaces it. Per step it adds the recorded inputs that
 * are due, builds a request with the injected `buildRequest`, streams the
 * provider, hands the step's calls to the replaying executor together, adds
 * the outputs and results to the conversation and asks the replay whether to
 * go on. It writes nothing durable.
 */
import type { CallId, MessageId, SessionId } from "../id.ts"
import { createInterrupt } from "../interrupt.ts"
import type { Provider, StreamEvent } from "../provider/provider.ts"
import type { Usage } from "../provider/usage.ts"
import type { InputItem, ModelRequest } from "../request/request.ts"
import { type ReplayOptions, createReplay } from "./replay.ts"
import type { ReplayReport } from "./report.ts"
import type { Tape, TapeInput } from "./tape.ts"

/** The conversation so far: recorded inputs, and the replay's own outputs and tool results as request items. */
export type ConversationEntry =
  | { readonly kind: "input"; readonly input: TapeInput }
  | { readonly kind: "output"; readonly item: InputItem }

export type BuildRequest = (
  conversation: readonly ConversationEntry[],
  context: { readonly tape: Tape; readonly step: number },
) => ModelRequest

export interface RunReplayOptions {
  readonly tape: Tape
  readonly provider: Provider
  readonly buildRequest: BuildRequest
  readonly replay: ReplayOptions
  /** Gives up after this many model calls. Defaults to the tape's step count plus 10. */
  readonly maxSteps?: number
}

export interface ReplayRun {
  readonly report: ReplayReport
  readonly conversation: readonly ConversationEntry[]
}

export async function runReplay(options: RunReplayOptions): Promise<ReplayRun> {
  const tape = options.tape
  const replay = createReplay(tape, options.replay)
  const conversation: ConversationEntry[] = []
  const interrupt = createInterrupt()
  const maxSteps = options.maxSteps ?? tape.steps.length + 10
  const finish = (): ReplayRun => ({ report: replay.report(), conversation })

  for (let step = 0; ; step += 1) {
    for (const input of replay.takeInputs()) conversation.push({ kind: "input", input })
    if (replay.status !== "on_tape" && replay.status !== "off_tape") return finish()
    if (step >= maxSteps) {
      replay.fail(`gave up after ${maxSteps} model calls`)
      return finish()
    }
    const response = await collect(options.provider.stream(options.buildRequest(conversation, { tape, step }), interrupt.signal))
    if (response.error !== null) {
      replay.fail(`the provider failed at step ${step + 1}: ${response.error}`)
      return finish()
    }
    for (const item of response.items) conversation.push({ kind: "output", item })
    const calls = response.items.flatMap((item) => (item.type === "tool_call" ? [item] : []))
    const messageId = `replay_${step + 1}` as MessageId
    const outcomes = await replay.executor.runAll(
      calls.map((call) => ({
        name: call.name,
        argumentsText: call.input,
        context: {
          sessionId: (tape.sessionId ?? "replay") as SessionId,
          messageId,
          callId: call.callId as CallId,
          cwd: tape.cwd,
          signal: interrupt.signal,
          progress: () => {},
        },
      })),
    )
    outcomes.forEach((outcome, index) =>
      conversation.push({
        kind: "output",
        item: { type: "tool_result", callId: calls[index]!.callId, output: outcome.settlement.output, attachments: outcome.settlement.attachments },
      }),
    )
    const text = response.items.flatMap((item) => (item.type === "assistant_text" ? [item.text] : [])).join("")
    const end = replay.endStep({ text, calls: calls.map((call) => ({ name: call.name, input: call.input })), usage: response.usage })
    if (end.action === "stop") return finish()
  }
}

async function collect(stream: AsyncIterable<StreamEvent>) {
  const items: InputItem[] = []
  let usage: Usage | null = null
  for await (const event of stream) {
    switch (event.type) {
      case "text.end":
        items.push({ type: "assistant_text", text: event.text, providerData: event.providerData })
        break
      case "reasoning.end":
        items.push({ type: "reasoning", text: event.text, providerData: event.providerData })
        break
      case "tool_call.end":
        items.push({ type: "tool_call", callId: event.callId, name: event.name, input: event.input, providerData: event.providerData })
        break
      case "usage":
        usage = event.usage
        break
      case "finish":
        return { items, usage, error: null }
      case "error":
        return { items, usage, error: `${event.error.kind}: ${event.error.message}` }
      default:
        break
    }
  }
  return { items, usage, error: "incomplete_stream: the stream ended without a terminal event" }
}
