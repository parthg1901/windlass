/** Shared fixtures for the replay tests: tapes from the step-loop scenarios, stand-in tools and a minimal request builder. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { text } from "../../src/content.ts"
import type { NewEvent } from "../../src/event/durable.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import type { BuildRequest } from "../../src/replay/driver.ts"
import { type Tape, tapeFromEvents } from "../../src/replay/tape.ts"
import type { InputItem } from "../../src/request/request.ts"
import type { ToolCall } from "../../src/tool/runtime.ts"
import type { Tool, ToolEffect } from "../../src/tool/tool.ts"
import { type Scenario, allEvents } from "../scenarios/script.ts"

export const tapeOf = (scenario: Scenario | readonly NewEvent[]): Tape =>
  tapeFromEvents("phases" in scenario ? allEvents(scenario) : scenario)

/** A tool that records every execution and answers with its name, cwd and arguments. */
export function standIn(name: string, effect: ToolEffect, runs: { name: string; cwd: string; input: unknown }[]): Tool<Record<string, unknown>> {
  return {
    name,
    description: `The ${name} tool`,
    inputSchema: { type: "object" },
    effect,
    execute: async (input, context) => {
      runs.push({ name, cwd: context.cwd, input })
      return { status: "success", output: `ran ${name} in ${context.cwd}`, truncation: null, attachments: [], display: null }
    },
  }
}

export function standIns() {
  const runs: { name: string; cwd: string; input: unknown }[] = []
  return { runs, tools: [standIn("read", "read", runs), standIn("shell", "exec", runs), standIn("write", "write", runs)] }
}

export function toolCall(name: string, argumentsText: string, cwd = "/repo", index = 1): ToolCall {
  return {
    name,
    argumentsText,
    context: {
      sessionId: "ses_replay" as SessionId,
      messageId: "replay_1" as MessageId,
      callId: `call_${index}` as CallId,
      cwd,
      signal: createInterrupt().signal,
      progress: () => {},
    },
  }
}

/** A stand-in for the real request builder: recorded inputs as user or developer messages, the replay's outputs as they are. */
export const simpleRequest =
  (instructions?: string): BuildRequest =>
  (conversation, context) => ({
    params: { model: context.tape.settings.model, reasoningEffort: null, textVerbosity: null, parallelToolCalls: true, cacheKey: null },
    tools: context.tape.baseline?.tools ?? [],
    instructions: instructions ?? context.tape.baseline?.instructions ?? "",
    input: conversation.flatMap((entry): InputItem[] => {
      if (entry.kind === "output") return [entry.item]
      const input = entry.input
      if (input.kind === "message") return [{ type: "message", role: input.from === "user" ? "user" : "developer", content: input.content }]
      if (input.kind === "instruction") return [{ type: "message", role: "developer", content: text(input.text) }]
      return []
    }),
    toolChoice: "auto",
  })

const dirs: string[] = []
export function tempDir(prefix = "lh-replay-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
export function removeTempDirs() {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
