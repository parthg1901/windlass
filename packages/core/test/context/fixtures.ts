/** Scripted message lists for the context tests. `seq` counts up from 1 and `time` is `seq * 10`. */
import { text } from "../../src/content.ts"
import type { CallId, MessageId } from "../../src/id.ts"
import type { AssistantMessage, AssistantPart, CompactionMessage, Message, SyntheticMessage, UserMessage } from "../../src/message/message.ts"
import type { ToolOutcome } from "../../src/event/durable.ts"

export interface CallSpec {
  readonly name: string
  readonly input: string | Record<string, unknown>
  readonly output: string
  readonly outcome?: ToolOutcome
}

export class Script {
  private seq = 0
  readonly messages: Message[] = []

  private next() {
    this.seq += 1
    return { id: `msg_${this.seq}` as MessageId, seq: this.seq, time: this.seq * 10, excluded: null }
  }

  user(value: string): this {
    const message: UserMessage = { kind: "user", ...this.next(), content: text(value), delivery: "steer" }
    this.messages.push(message)
    return this
  }

  synthetic(origin: string, value: string): this {
    const message: SyntheticMessage = { kind: "synthetic", ...this.next(), origin, content: text(value), delivery: null }
    this.messages.push(message)
    return this
  }

  /** One step: optional text, then calls with their settled results. */
  step(options: { text?: string; calls?: readonly CallSpec[]; status?: AssistantMessage["status"] } = {}): this {
    const base = this.next()
    const calls = (options.calls ?? []).map(
      (call, index): AssistantPart => ({
        type: "tool_call",
        callId: `call_${base.seq}_${index}` as CallId,
        name: call.name,
        input: typeof call.input === "string" ? call.input : JSON.stringify(call.input),
        providerData: null,
        state: {
          status: "settled",
          outcome: call.outcome ?? "success",
          output: call.output,
          truncation: null,
          attachments: [],
          display: null,
        },
      }),
    )
    const parts: AssistantPart[] = [...(options.text === undefined ? [] : [{ type: "text" as const, text: options.text, providerData: null }]), ...calls]
    const status = options.status ?? "completed"
    const message: AssistantMessage = {
      kind: "assistant",
      ...base,
      model: "gpt-6-luna",
      attempt: 1,
      status,
      parts,
      finish: status === "completed" ? (calls.length > 0 ? "tool_calls" : "stop") : null,
      usage: null,
      error: status === "failed" ? { kind: "crashed" } : null,
      refusal: null,
      lastRetry: null,
      endedAt: base.time,
    }
    this.messages.push(message)
    return this
  }

  checkpoint(summary: string, keepFromSeq: number): this {
    const message: CompactionMessage = {
      kind: "compaction",
      ...this.next(),
      trigger: "auto",
      status: "completed",
      summary,
      keepFromSeq,
      usage: null,
      error: null,
      endedAt: null,
    }
    this.messages.push(message)
    return this
  }
}

export const shell = (command: string, output: string, exitCode = 0): CallSpec => ({
  name: "shell",
  input: { command },
  output: exitCode === 0 ? output : `${output}\n[Exit code ${exitCode}]`,
  outcome: exitCode === 0 ? "success" : "error",
})

export const read = (path: string, output: string): CallSpec => ({ name: "read", input: { path }, output })

/** Deterministic filler prose of about `words` words. */
export function filler(words: number, salt = 0): string {
  const vocabulary = ["the", "parser", "returns", "a", "value", "when", "input", "is", "valid", "otherwise", "throws", "and", "logs", "details", "for", "review"]
  return Array.from({ length: words }, (_, index) => vocabulary[(index * 7 + salt) % vocabulary.length]).join(" ")
}
