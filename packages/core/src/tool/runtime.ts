/**
 * The tool runtime: from a tool name, the argument text exactly as the model
 * produced it and a context, to the one terminal outcome of the call. It
 * never touches storage; the step loop writes `tool.started` from `onStart`
 * and `tool.settled` from `outcome.settlement`.
 *
 * Order for one call:
 *   1. aborted already          -> `not_started`        (onStart is not called)
 *   2. unknown tool             -> `refused`, error     (onStart is not called)
 *   3. arguments not JSON       -> `refused`, error     (onStart is not called)
 *   4. arguments fail schema    -> `refused`, error     (onStart is not called)
 *   5. onStart(), then execute:
 *      returned                 -> `completed`, the tool's status, output capped once
 *      threw                    -> `crashed`, error for `read` tools, effect_unknown otherwise
 */
import type { BlobRef } from "../content.ts"
import type { Json } from "../json.ts"
import { interruptReasonOf } from "../interrupt.ts"
import { excerpt, parseArguments } from "./args.ts"
import { OUTPUT_LIMITS, type OutputLimits, capOutput } from "./cap.ts"
import { type SchemaCheck, compileSchema } from "./schema.ts"
import type { AnyTool, PutBlob, ToolContext, ToolResult, Truncation } from "./tool.ts"

/** Exactly the fields of the `tool.settled` event besides `messageId` and `callId`. */
export interface Settlement<Outcome extends "success" | "error" | "not_started" | "effect_unknown"> {
  readonly outcome: Outcome
  readonly output: string
  readonly truncation: Truncation | null
  readonly attachments: readonly BlobRef[]
  readonly display: Json | null
}

/**
 * The terminal outcome of one call. `kind` says how far the call got, which
 * fixes what the step loop has written: `not_started` and `refused` never
 * called `onStart` (settle from `pending`), `completed` and `crashed` did
 * (settle from `running`). The `outcome` inside `settlement` is already the
 * right one for the event; the step loop never maps it.
 */
export type ToolCallOutcome =
  | { readonly kind: "not_started"; readonly settlement: Settlement<"not_started"> }
  | {
      readonly kind: "refused"
      readonly reason: "unknown_tool" | "malformed_arguments" | "invalid_arguments"
      readonly settlement: Settlement<"error">
    }
  | { readonly kind: "completed"; readonly settlement: Settlement<"success" | "error"> }
  | {
      /** The tool threw (a bug in the tool). `error` is for logs only. */
      readonly kind: "crashed"
      readonly error: unknown
      readonly settlement: Settlement<"error" | "effect_unknown">
    }

/** What the caller knows about one call. The runtime adds what it owns (`putBlob`) to make the tool's `ToolContext`. */
export type ToolCallContext = Omit<ToolContext, "putBlob">

export interface ToolCall {
  readonly name: string
  /** The argument text exactly as the model produced it. */
  readonly argumentsText: string
  readonly context: ToolCallContext
}

export interface RunHooks {
  /**
   * Called synchronously right before `execute`, after the input was accepted.
   * The step loop writes `tool.started` here. If it throws, the tool does not
   * run and the call's promise rejects with that error.
   */
  readonly onStart?: () => void
}

export interface ToolRuntimeOptions {
  readonly tools: readonly AnyTool[]
  /** Where capped output is written in full. Created on first use. */
  readonly spillDir: string
  /**
   * Where tools store media they return, normally `store.putBlob`. Every
   * call's context gets it, so a tool can attach an image without knowing
   * about the store.
   */
  readonly putBlob: PutBlob
  readonly limits?: OutputLimits
}

export interface ToolRuntime {
  readonly tools: readonly AnyTool[]
  /** Runs one call to its terminal outcome. Rejects only when `onStart` throws. */
  readonly run: (call: ToolCall, hooks?: RunHooks) => Promise<ToolCallOutcome>
  /**
   * Runs calls concurrently and resolves with their outcomes in input order.
   * A slow or failing call does not hold up or affect the others' outcomes;
   * the aborts reach every call through its context's signal (give them all
   * the execution's signal). `onStart` receives the index of the call.
   */
  readonly runAll: (calls: readonly ToolCall[], hooks?: { readonly onStart?: (index: number) => void }) => Promise<ToolCallOutcome[]>
}

export function createToolRuntime(options: ToolRuntimeOptions): ToolRuntime {
  const limits = options.limits ?? OUTPUT_LIMITS
  const registry = new Map(options.tools.map((tool) => [tool.name, { tool, check: compileSchema(tool.inputSchema) }]))
  if (registry.size !== options.tools.length) throw new Error("tool names must be unique")

  const run = async (call: ToolCall, hooks: RunHooks = {}): Promise<ToolCallOutcome> => {
    const reason = interruptReasonOf(call.context.signal)
    if (reason !== null) return notStarted(reason)
    const entry = registry.get(call.name)
    if (entry === undefined)
      return refused(
        "unknown_tool",
        `There is no tool named ${JSON.stringify(call.name)}. Available tools: ${[...registry.keys()].join(", ")}.`,
      )
    const input = acceptInput(entry.tool.name, entry.check, call.argumentsText)
    if (!input.ok) return input.outcome
    hooks.onStart?.()
    const result = await execute(entry.tool, input.value, { ...call.context, putBlob: options.putBlob })
    if (!result.ok) return crashed(entry.tool, result.error)
    if (result.value.truncation !== null)
      return { kind: "completed", settlement: { ...settlementOf(result.value), outcome: result.value.status } }
    const capped = await capOutput(result.value.output, options.spillDir, limits)
    return {
      kind: "completed",
      settlement: { ...settlementOf(result.value), outcome: result.value.status, output: capped.output, truncation: capped.truncation },
    }
  }

  return {
    tools: options.tools,
    run,
    runAll: (calls, hooks = {}) => Promise.all(calls.map((call, index) => run(call, { onStart: () => hooks.onStart?.(index) }))),
  }
}

function acceptInput(
  name: string,
  check: SchemaCheck,
  argumentsText: string,
): { readonly ok: true; readonly value: Json } | { readonly ok: false; readonly outcome: ToolCallOutcome } {
  const parsed = parseArguments(argumentsText)
  if (!parsed.ok)
    return {
      ok: false,
      outcome: refused(
        "malformed_arguments",
        `The arguments for ${name} are not valid JSON (${parsed.problem}). Received: ${parsed.excerpt}\nCall ${name} again with the arguments as one JSON object.`,
      ),
    }
  const issues = check(parsed.value)
  if (issues.length === 0) return { ok: true, value: parsed.value }
  const lines = issues.slice(0, 5).map((issue) => `- ${issue.path === "" ? "arguments" : issue.path}: ${issue.message}`)
  if (issues.length > 5) lines.push(`- and ${issues.length - 5} more`)
  return {
    ok: false,
    outcome: refused("invalid_arguments", `Invalid arguments for ${name}:\n${lines.join("\n")}\nFix them and call ${name} again.`),
  }
}

async function execute(
  tool: AnyTool,
  input: Json,
  context: ToolContext,
): Promise<{ readonly ok: true; readonly value: ToolResult } | { readonly ok: false; readonly error: unknown }> {
  try {
    // The one cast: `input` was validated against the tool's own schema.
    const value: unknown = await tool.execute(input as never, context)
    if (!isToolResult(value)) return { ok: false, error: new Error(`${tool.name} returned something that is not a ToolResult`) }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error }
  }
}

function crashed(tool: AnyTool, error: unknown): ToolCallOutcome {
  const message = excerpt(error instanceof Error ? error.message : String(error), 500)
  const base = { truncation: null, attachments: [], display: null }
  if (tool.effect === "read")
    return { kind: "crashed", error, settlement: { ...base, outcome: "error", output: `${tool.name} failed with an internal error: ${message}` } }
  return {
    kind: "crashed",
    error,
    settlement: {
      ...base,
      outcome: "effect_unknown",
      output: `${tool.name} failed with an internal error after it started: ${message}\nIt may or may not have made its change. Check the current state before calling it again.`,
    },
  }
}

function notStarted(reason: "user" | "shutdown"): ToolCallOutcome {
  return {
    kind: "not_started",
    settlement: {
      outcome: "not_started",
      output: `Not run: the ${reason === "user" ? "user interrupted" : "harness shut down"} before this call started.`,
      truncation: null,
      attachments: [],
      display: null,
    },
  }
}

function refused(reason: "unknown_tool" | "malformed_arguments" | "invalid_arguments", output: string): ToolCallOutcome {
  return { kind: "refused", reason, settlement: { outcome: "error", output, truncation: null, attachments: [], display: null } }
}

function settlementOf(result: ToolResult) {
  return { output: result.output, truncation: result.truncation, attachments: result.attachments, display: result.display }
}

function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== "object" || value === null) return false
  const result = value as Record<string, unknown>
  return (
    (result.status === "success" || result.status === "error") &&
    typeof result.output === "string" &&
    (result.truncation === null || typeof result.truncation === "object") &&
    Array.isArray(result.attachments) &&
    result.display !== undefined
  )
}
