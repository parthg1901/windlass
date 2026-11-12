/**
 * What a hook is given: the event as one line of JSON on stdin, and a few environment variables for the common
 * cases, so a one-line hook needs no JSON parser. Pure.
 *
 * The event is bounded (`EVENT_LIMITS`): a value that does not fit is left out or cut and the event says so,
 * never silently. It is a copy: nothing a hook does with it reaches the call, the result or the log.
 *
 * stdin, version 1:
 *
 *   { "version": 1, "point": "beforeTool" | "afterTool" | "stop", "session": "<id>", "cwd": "<dir>",
 *     "hook": { "name": "...", "origin": "user" | "project" },
 *     "tool": { "name": "shell", "callId": "...", "arguments": { ... } | null, "argumentsBytes": 123,
 *               "paths": ["src/a.ts"] | null },                                         (before and after)
 *     "result": { "status": "success" | "error", "output": "...", "outputBytes": 456, "outputCut": false },  (after)
 *     "turn": { "round": 1, "maxRounds": 3, "lastText": "...", "lastTextCut": false } }  (stop)
 *
 * Environment (the prefix is the product's directory name in capitals, from `brand.ts`):
 *   <P>_HOOK_POINT, <P>_HOOK_NAME, <P>_HOOK_ORIGIN, <P>_HOOK_TOOL (before, after),
 *   <P>_HOOK_COMMAND (before, after: the call's `command` argument when it has one, as a shell call does),
 *   <P>_HOOK_PATHS (before, after: the call's paths relative to the working directory, one per line),
 *   <P>_HOOK_STATUS (after), <P>_HOOK_ROUND and <P>_HOOK_MAX_ROUNDS (stop).
 * A value over `EVENT_LIMITS.envValue` is not set; the stdin event still has it (or says it was cut).
 */
import { brand } from "../brand.ts"
import type { Json } from "../json.ts"
import type { HookOrigin, HookPoint } from "./config.ts"

export const HOOK_ENV_PREFIX = `${brand.envPrefix}HOOK_`

export const EVENT_LIMITS = {
  /** The arguments object, as JSON. Larger: `arguments` is `null` and `argumentsBytes` says how large it was. */
  arguments: 24 * 1024,
  /** The result text given to an after hook: its beginning. */
  output: 16 * 1024,
  /** The model's last text given to a stop hook: its end. */
  lastText: 8 * 1024,
  /** One environment variable's value. */
  envValue: 16 * 1024,
} as const

interface Common {
  readonly sessionId: string
  readonly cwd: string
  readonly hook: { readonly name: string; readonly origin: HookOrigin }
}

export interface ToolCallFacts {
  readonly name: string
  readonly callId: string
  /** The validated arguments, as recorded. */
  readonly arguments: Json
  /** Relative to the working directory (`relativePaths`), or `null` when the tool names none. */
  readonly paths: readonly string[] | null
}

export type HookEventInput =
  | (Common & { readonly point: "beforeTool"; readonly tool: ToolCallFacts })
  | (Common & { readonly point: "afterTool"; readonly tool: ToolCallFacts; readonly result: { readonly status: "success" | "error"; readonly output: string } })
  | (Common & { readonly point: "stop"; readonly round: number; readonly maxRounds: number; readonly lastText: string })

export interface HookEvent {
  readonly point: HookPoint
  /** One line of JSON, no newline in it. */
  readonly stdin: string
  readonly env: Readonly<Record<string, string>>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function hookEvent(input: HookEventInput): HookEvent {
  const env: Record<string, string> = {}
  const set = (name: string, value: string) => {
    if (encoder.encode(value).length <= EVENT_LIMITS.envValue) env[`${HOOK_ENV_PREFIX}${name}`] = value
  }
  set("POINT", input.point)
  set("NAME", input.hook.name)
  set("ORIGIN", input.hook.origin)
  const base = { version: 1, point: input.point, session: input.sessionId, cwd: input.cwd, hook: { name: input.hook.name, origin: input.hook.origin } }
  let body: Record<string, Json>
  if (input.point === "stop") {
    const last = tail(input.lastText, EVENT_LIMITS.lastText)
    body = { ...base, turn: { round: input.round, maxRounds: input.maxRounds, lastText: last.text, lastTextCut: last.cut } }
    set("ROUND", String(input.round))
    set("MAX_ROUNDS", String(input.maxRounds))
  } else {
    const argumentsJson = JSON.stringify(input.tool.arguments)
    const argumentsBytes = encoder.encode(argumentsJson).length
    const tool = {
      name: input.tool.name,
      callId: input.tool.callId,
      arguments: argumentsBytes <= EVENT_LIMITS.arguments ? input.tool.arguments : null,
      argumentsBytes,
      paths: input.tool.paths === null ? null : [...input.tool.paths],
    }
    body = { ...base, tool }
    set("TOOL", input.tool.name)
    const command = commandOf(input.tool.arguments)
    if (command !== null) set("COMMAND", command)
    if (input.tool.paths !== null) set("PATHS", input.tool.paths.join("\n"))
    if (input.point === "afterTool") {
      const head = headOf(input.result.output, EVENT_LIMITS.output)
      body = { ...body, result: { status: input.result.status, output: head.text, outputBytes: head.bytes, outputCut: head.cut } }
      set("STATUS", input.result.status)
    }
  }
  return { point: input.point, stdin: JSON.stringify(body), env }
}

function commandOf(args: Json): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null
  const command = (args as Record<string, Json>).command
  return typeof command === "string" ? command : null
}

function headOf(text: string, limit: number) {
  const bytes = encoder.encode(text)
  if (bytes.length <= limit) return { text, bytes: bytes.length, cut: false }
  // `stream: true` holds back a character cut in two instead of decoding it as U+FFFD.
  return { text: new TextDecoder().decode(bytes.subarray(0, limit), { stream: true }), bytes: bytes.length, cut: true }
}

function tail(text: string, limit: number) {
  const bytes = encoder.encode(text)
  if (bytes.length <= limit) return { text, cut: false }
  let start = bytes.length - limit
  // Skip continuation bytes so the tail starts on a character.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1
  return { text: decoder.decode(bytes.subarray(start)), cut: true }
}
