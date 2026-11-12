/** Builds stored `Message` values for generated sessions, so Part A's functions run on them unchanged. */
import { text } from "../../packages/core/src/content.ts"
import type { ToolOutcome } from "../../packages/core/src/event/durable.ts"
import type { CallId, MessageId } from "../../packages/core/src/id.ts"
import type { AssistantMessage, AssistantPart, Message } from "../../packages/core/src/message/message.ts"

export const MODEL = "gpt-6-luna"

export interface Call {
  readonly name: string
  readonly input: Record<string, unknown>
  readonly output: string
  readonly outcome?: ToolOutcome
}

export class SessionBuilder {
  private seq = 0
  readonly messages: Message[] = []

  private base() {
    this.seq += 1
    return { id: `msg_${String(this.seq).padStart(4, "0")}` as MessageId, seq: this.seq, time: 1_800_000_000_000 + this.seq * 1_000, excluded: null }
  }

  user(value: string): number {
    const base = this.base()
    this.messages.push({ kind: "user", ...base, content: text(value), delivery: "steer" })
    return base.seq
  }

  /** One step: optional text first, then the calls with their settled results. */
  step(options: { text?: string; calls?: readonly Call[] }): number {
    const base = this.base()
    const calls = (options.calls ?? []).map(
      (call, index): AssistantPart => ({
        type: "tool_call",
        callId: `call_${base.seq}_${index}` as CallId,
        name: call.name,
        input: JSON.stringify(call.input),
        providerData: null,
        state: { status: "settled", outcome: call.outcome ?? "success", output: call.output, truncation: null, attachments: [], display: null },
      }),
    )
    const parts: AssistantPart[] = [...(options.text === undefined ? [] : [{ type: "text" as const, text: options.text, providerData: null }]), ...calls]
    const message: AssistantMessage = {
      kind: "assistant",
      ...base,
      model: MODEL,
      attempt: 1,
      status: "completed",
      parts,
      finish: calls.length > 0 ? "tool_calls" : "stop",
      usage: null,
      error: null,
      refusal: null,
      lastRetry: null,
      endedAt: base.time,
    }
    this.messages.push(message)
    return base.seq
  }
}

/** A shell call in the shape the real shell tool returns: output, then `[Exit code N]` when it is not 0. */
export function shell(command: string, output: string, exitCode = 0): Call {
  return {
    name: "shell",
    input: { command },
    output: exitCode === 0 ? output : `${output}${output.endsWith("\n") ? "" : "\n"}[Exit code ${exitCode}]`,
    outcome: exitCode === 0 ? "success" : "error",
  }
}

/** A read call with numbered lines, as the real read tool returns them. */
export function read(path: string, lines: readonly string[], from = 1): Call {
  const width = String(from + lines.length - 1).length
  return { name: "read", input: { path }, output: lines.map((line, index) => `${String(from + index).padStart(width, " ")}\t${line}`).join("\n") }
}

export function grep(pattern: string, matches: readonly string[]): Call {
  return { name: "grep", input: { pattern }, output: matches.length === 0 ? "No matches." : matches.join("\n") }
}

export function edit(path: string, oldString: string, newString: string, line: number): Call {
  return { name: "edit", input: { path, old_string: oldString, new_string: newString }, output: `Edited ${path}: replaced 1 occurrence (line ${line}).` }
}
