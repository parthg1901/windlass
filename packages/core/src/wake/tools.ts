/**
 * The wake-up tools. Their specs are constants: nothing in a description or schema depends on what is stored, so
 * the frozen tool list never changes with the wake-ups a session has.
 *
 * - `wake_create` (effect `exec`): a wake-up may run a command later, unattended and repeatedly, and it starts
 *   a turn nobody may be watching. The approval layer decides on it exactly as on a shell command: its input has
 *   the shell's `command` and `sandbox` arguments at the top level, so `callFacts` reads them the same way, and
 *   the decision the call ran under (`ToolContext.sandbox`) is recorded on the wake-up as the most its check may
 *   ever run with. A timer or a webhook has no command; it is still decided as `exec`.
 * - `wake_list` (effect `read`): this session's wake-ups, with every limit that applies to them.
 * - `wake_cancel` (effect `write`): stops one of this session's wake-ups. `write` because it changes state that
 *   outlives the call, so an unobserved outcome settles as `effect_unknown`.
 *
 * The tools only write records. They never start a timer or run a command; the scheduler does, and `changed`
 * tells it to look.
 */
import { escalationSchema } from "../approval/escalation.ts"
import type { Json } from "../json.ts"
import type { Tool, ToolContext, ToolResult } from "../tool/tool.ts"
import { localTimeZone } from "./cron.ts"
import { type RunAs, type TriggerRequest, type WakeUp, WAKE_LIMITS, describeRun, describeTrigger, duration, isoTime } from "./record.ts"
import type { WakeStore } from "./store.ts"

export const WAKE_CREATE_TOOL = "wake_create"
export const WAKE_LIST_TOOL = "wake_list"
export const WAKE_CANCEL_TOOL = "wake_cancel"

export interface WakeToolOptions {
  /** The store, reached through the call's context. */
  readonly store: (context: ToolContext) => WakeStore
  /** Whether the call's session has taken in untrusted content (the approval layer's taint). Recorded, not acted on here. */
  readonly sessionTainted: (context: ToolContext) => boolean
  /** The session's `seq` at the call, when the engine knows it. */
  readonly seqOf?: (context: ToolContext) => number | null
  /** Where a webhook wake-up receives requests, e.g. `http://127.0.0.1:47863/w/<id>`. */
  readonly webhookUrl: (wakeId: string) => string
  /** Tells the scheduler and the listener to look again. */
  readonly changed?: () => void
  /** Default for cron expressions: the user's time zone. */
  readonly timeZone?: string
  readonly now?: () => number
}

export interface CreateInput {
  readonly message: string
  readonly trigger: "at" | "after" | "every" | "cron" | "check" | "webhook"
  readonly at?: string
  readonly seconds?: number
  readonly cron?: string
  readonly timeZone?: string
  readonly command?: string
  readonly fire?: "until" | "on_change"
  readonly timeoutSeconds?: number
  readonly includeOutput?: boolean
  readonly sandbox?: { readonly network?: boolean; readonly write?: readonly string[] }
  readonly includeBody?: boolean
  readonly delivery?: "wake" | "queue"
  readonly maxFirings?: number
  readonly expiresInSeconds?: number
  readonly minIntervalSeconds?: number
}

const M = WAKE_LIMITS.model

const CREATE_DESCRIPTION = [
  "Set up a wake-up: a message delivered to this session later, when a time comes, when a command passes or its output changes, or when a signed webhook request arrives. Waiting costs nothing: no model call is made until it fires. When it fires you receive your message as a new turn, marked as coming from the wake-up; nobody may be watching then, so questions to the user will be refused.",
  "",
  "Use a wake-up instead of sleeping, polling in a loop, or keeping a command running, when what you wait for can take more than a few minutes or outlast this conversation turn: CI or a deploy finishing, a reminder at a time, retrying something every ten minutes until it passes. For something that finishes within a couple of minutes, run the command (with a timeout) or in the background instead. Tell the user what you set up.",
  "",
  "Triggers (`trigger`):",
  '- "at": once at `at`, an ISO 8601 time with an offset, e.g. "2026-11-12T17:00:00+01:00".',
  '- "after": once, `seconds` from now.',
  '- "every": every `seconds` (at least 60), up to `maxFirings` times.',
  '- "cron": a five-field cron expression in `cron` ("minute hour day month weekday", e.g. "0 9 * * mon-fri"), in `timeZone` or the user\'s time zone.',
  '- "check": run `command` every `seconds` (at least 15) in the working directory, without a model call. `fire: "until"` fires once, the first time it exits 0 (e.g. `gh run view 123 --exit-status`); `fire: "on_change"` fires each time its output or exit code differs from the run before. Its output is included in the message unless `includeOutput` is false. It runs as your shell commands do, in the sandbox without network unless you ask for more with `sandbox` (the user is asked now, and it never gets more later).',
  '- "webhook": fires when an HTTP request signed with this wake-up\'s secret arrives at its local URL. The secret is shown to the user, not to you; the request body is included as untrusted content unless `includeBody` is false.',
  "",
  `\`delivery\`: "wake" (default) starts a turn if the session is idle, otherwise after the current turn; "queue" only waits in the inbox for the next turn. Limits: at most ${M.maxActive} pending wake-ups per session; \`maxFirings\` up to ${M.maxFirings.max} (default ${M.maxFirings.default}); it expires after \`expiresInSeconds\` (default ${M.expiry.defaultMs / 3_600_000} hours, at most ${M.expiry.maxMs / 86_400_000} days); at least \`minIntervalSeconds\` between firings (default ${WAKE_LIMITS.minInterval.defaultMs / 1000}); and the session receives at most a fixed number of firings per hour in total.`,
].join("\n")

const LIST_DESCRIPTION =
  "List this session's wake-ups: each one's ID, trigger, state, when it is next due, how often it has fired, and the limits that apply (maximum firings, expiry, minimum interval, the session's hourly ceiling). Ended ones are included with `includeEnded`."

const CANCEL_DESCRIPTION = "Cancel one of this session's wake-ups by its ID (wk_…). It will not fire again, and a firing not yet delivered is dropped."

export function wakeCreateTool(options: WakeToolOptions): Tool<CreateInput> {
  return {
    name: WAKE_CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", minLength: 1, maxLength: WAKE_LIMITS.messageChars, description: "What you will be told when it fires: what to do then, with whatever context you will need. It is all you will get besides the trigger's output." },
        trigger: { type: "string", enum: ["at", "after", "every", "cron", "check", "webhook"], description: "What makes it fire; see the tool description." },
        at: { type: "string", description: 'For "at": an ISO 8601 time with an offset or Z.' },
        seconds: { type: "integer", minimum: 1, description: 'For "after": the delay. For "every": the interval. For "check": the time between runs.' },
        cron: { type: "string", description: 'For "cron": the five-field expression.' },
        timeZone: { type: "string", description: 'For "cron": an IANA time zone such as "Europe/Berlin". Default: the user\'s.' },
        command: { type: "string", minLength: 1, maxLength: WAKE_LIMITS.commandChars, description: 'For "check": the shell command, run with `-c` in the working directory.' },
        fire: { type: "string", enum: ["until", "on_change"], description: 'For "check": "until" it exits 0 (once), or "on_change" of its output.' },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: WAKE_LIMITS.check.timeout.maxMs / 1000, description: 'For "check": seconds before one run is stopped. Default 60, or the interval if shorter.' },
        includeOutput: { type: "boolean", description: 'For "check": include the command\'s output (its beginning and end) in the message. Default true.' },
        sandbox: escalationSchema,
        includeBody: { type: "boolean", description: 'For "webhook": include the request body in the message. Default true.' },
        delivery: { type: "string", enum: ["wake", "queue"], description: '"wake" (default): start a turn when it fires. "queue": wait for the next turn.' },
        maxFirings: { type: "integer", minimum: 1, maximum: M.maxFirings.max, description: `For repeating triggers: the most times it fires. Default ${M.maxFirings.default}.` },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: M.expiry.maxMs / 1000, description: "It stops after this long. Default one day." },
        minIntervalSeconds: { type: "integer", minimum: WAKE_LIMITS.minInterval.minMs / 1000, description: "The least time between two firings. Default 60." },
      },
      required: ["message", "trigger"],
      additionalProperties: false,
    },
    effect: "exec",
    execute: async (input, context) => {
      const now = (options.now ?? Date.now)()
      const trigger = triggerOf(input, options.timeZone)
      if (typeof trigger === "string") return result("error", trigger, { action: "create", id: null })
      const store = options.store(context)
      const created = store.create({
        sessionId: context.sessionId,
        message: input.message,
        trigger,
        author: "model",
        messageId: context.messageId,
        callId: context.callId,
        seq: options.seqOf?.(context) ?? null,
        tainted: options.sessionTainted(context),
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        ...(input.maxFirings === undefined ? {} : { maxFirings: input.maxFirings }),
        ...(input.expiresInSeconds === undefined ? {} : { expiresAt: now + input.expiresInSeconds * 1000 }),
        ...(input.minIntervalSeconds === undefined ? {} : { minIntervalMs: input.minIntervalSeconds * 1000 }),
        ...(trigger.kind === "check" ? { run: decidedRun(context), cwd: context.cwd } : {}),
      })
      if (!created.ok) return result("error", created.error, { action: "create", id: null })
      options.changed?.()
      const wake = created.wake
      const lines = [`Created wake-up ${wake.id}: ${describeTrigger(wake.trigger)}.`, ...describeLines(wake, store.hourlyCeiling, options.webhookUrl)]
      if (wake.trigger.kind === "webhook")
        lines.push("The secret that signs requests is shown to the user, not to you. Tell the user the URL and how to send a signed request (the harness's wake-up guide has curl and GitHub examples).")
      return result("success", lines.join("\n"), { action: "create", id: wake.id })
    },
  }
}

export function wakeListTool(options: WakeToolOptions): Tool<{ readonly includeEnded?: boolean }> {
  return {
    name: WAKE_LIST_TOOL,
    description: LIST_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { includeEnded: { type: "boolean", description: "Also list wake-ups that completed, were cancelled, expired or failed. Default false." } },
      additionalProperties: false,
    },
    effect: "read",
    execute: async (input, context) => {
      const store = options.store(context)
      const wakes = store.list({ sessionId: context.sessionId, includeEnded: input.includeEnded === true })
      const now = (options.now ?? Date.now)()
      const window = store.hourly(context.sessionId, now)
      const header = `The session's ceiling: ${store.hourlyCeiling} firings per hour (${window.count} in the last hour). At most ${M.maxActive} pending wake-ups created by you.`
      if (wakes.length === 0) return result("success", `${header}\nNo ${input.includeEnded === true ? "" : "pending "}wake-ups in this session.`, { action: "list", id: null })
      const text = [header, ...wakes.map((wake) => [`${wake.id} · ${describeTrigger(wake.trigger)}`, ...describeLines(wake, store.hourlyCeiling, options.webhookUrl).map((line) => `  ${line}`)].join("\n"))].join("\n\n")
      return result("success", text, { action: "list", id: null })
    },
  }
}

export function wakeCancelTool(options: WakeToolOptions): Tool<{ readonly id: string; readonly reason?: string }> {
  return {
    name: WAKE_CANCEL_TOOL,
    description: CANCEL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "The wake-up's ID, e.g. wk_3f9a2c1b4d5e." },
        reason: { type: "string", description: "Why, in a few words." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    effect: "write",
    execute: async (input, context) => {
      const cancelled = options.store(context).cancel(input.id.trim(), { by: "model", sessionId: context.sessionId, ...(input.reason === undefined ? {} : { reason: input.reason }) })
      if (!cancelled.ok) return result("error", cancelled.error, { action: "cancel", id: input.id })
      options.changed?.()
      return result("success", `Cancelled wake-up ${cancelled.wake.id} (${describeTrigger(cancelled.wake.trigger)}). It had fired ${cancelled.wake.fired} ${cancelled.wake.fired === 1 ? "time" : "times"}.`, { action: "cancel", id: cancelled.wake.id })
    },
  }
}

export function wakeTools(options: WakeToolOptions): [Tool<CreateInput>, Tool<{ readonly includeEnded?: boolean }>, Tool<{ readonly id: string; readonly reason?: string }>] {
  return [wakeCreateTool(options), wakeListTool(options), wakeCancelTool(options)]
}

/**
 * The run the approval layer let this call run under, which is the most the check may ever run with. Absent or
 * `null` means it let the call run as it is (`full` mode, or no approval layer), which the shell treats the same way.
 */
function decidedRun(context: ToolContext): RunAs {
  const decided = context.sandbox
  if (decided === undefined || decided === null) return { kind: "unsandboxed" }
  return { kind: "sandboxed", network: decided.network, writableRoots: [...decided.writableRoots] }
}

/** The trigger the input asks for, or why it is not valid, in words the model can act on. */
function triggerOf(input: CreateInput, timeZone: string | undefined): TriggerRequest | string {
  const needs = (field: keyof CreateInput, what: string) => (input[field] === undefined ? `A "${input.trigger}" wake-up needs \`${field}\`: ${what}.` : null)
  const extra = (allowed: readonly (keyof CreateInput)[]) => {
    const specific: (keyof CreateInput)[] = ["at", "seconds", "cron", "timeZone", "command", "fire", "timeoutSeconds", "includeOutput", "sandbox", "includeBody"]
    const wrong = specific.filter((field) => input[field] !== undefined && !allowed.includes(field))
    return wrong.length === 0 ? null : `${wrong.map((field) => `\`${field}\``).join(", ")} ${wrong.length === 1 ? "does" : "do"} not apply to a "${input.trigger}" wake-up.`
  }
  switch (input.trigger) {
    case "at": {
      const problem = needs("at", "an ISO 8601 time with an offset") ?? extra(["at"])
      if (problem !== null) return problem
      if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(input.at!.trim())) return `The time "${input.at}" has no offset; add one (e.g. "+01:00") or "Z" so it means one moment.`
      const at = Date.parse(input.at!)
      if (Number.isNaN(at)) return `"${input.at}" is not an ISO 8601 time.`
      return { kind: "at", at }
    }
    case "after":
      return needs("seconds", "the delay") ?? extra(["seconds"]) ?? { kind: "after", delayMs: input.seconds! * 1000 }
    case "every":
      return needs("seconds", "the interval") ?? extra(["seconds"]) ?? { kind: "every", intervalMs: input.seconds! * 1000 }
    case "cron":
      return needs("cron", 'a five-field expression such as "0 9 * * mon-fri"') ?? extra(["cron", "timeZone"]) ?? { kind: "cron", expression: input.cron!, timeZone: input.timeZone ?? timeZone ?? localTimeZone() }
    case "check": {
      const problem =
        needs("command", "the command to run") ?? needs("seconds", "the time between runs") ?? needs("fire", '"until" or "on_change"') ?? extra(["command", "seconds", "fire", "timeoutSeconds", "includeOutput", "sandbox"])
      if (problem !== null) return problem
      return {
        kind: "check",
        command: input.command!,
        intervalMs: input.seconds! * 1000,
        fire: input.fire!,
        ...(input.timeoutSeconds === undefined ? {} : { timeoutMs: input.timeoutSeconds * 1000 }),
        ...(input.includeOutput === undefined ? {} : { includeOutput: input.includeOutput }),
      }
    }
    case "webhook":
      return extra(["includeBody"]) ?? { kind: "webhook", ...(input.includeBody === undefined ? {} : { includeBody: input.includeBody }) }
    default:
      return `Unknown trigger "${String((input as { trigger: unknown }).trigger)}".`
  }
}

/** The state, the next time and every limit of a wake-up, one fact per line. Clients show the same lines. */
export function describeLines(wake: WakeUp, hourlyCeiling: number, webhookUrl?: (id: string) => string): string[] {
  const state =
    wake.state.kind === "pending"
      ? wake.trigger.kind === "webhook"
        ? "waiting for a request"
        : wake.nextAt === null
          ? "pending"
          : `next ${isoTime(wake.nextAt)}${wake.held === null ? "" : ` (held: ${wake.held})`}`
      : `${wake.state.kind}${wake.state.at === null ? "" : ` ${isoTime(wake.state.at)}`}${wake.state.reason === null ? "" : `: ${wake.state.reason}`}`
  const lines = [
    `State: ${state}. Fired ${wake.fired} of at most ${wake.limits.maxFirings}${wake.lastFiredAt === null ? "" : `, last ${isoTime(wake.lastFiredAt)}`}.`,
    `Limits: expires ${isoTime(wake.limits.expiresAt)}; at least ${duration(wake.limits.minIntervalMs)} between firings; at most ${hourlyCeiling} firings per hour for the session. Delivery: ${wake.delivery === "wake" ? "starts a turn" : "waits for the next turn"}.`,
    `Created by ${wake.provenance.author === "user" ? "the user" : "the model"} ${isoTime(wake.provenance.createdAt)}${wake.provenance.tainted ? ", while the session held untrusted content" : ""}.`,
  ]
  if (wake.trigger.kind === "check" && wake.run !== null) {
    lines.push(`The check runs ${describeRun(wake.run)}, as approved when it was created.${wake.lastRun === null ? " It has not run yet." : ` Last run: ${wake.lastRun}.`}`)
    if (wake.errors > 0) lines.push(`${wake.errors} consecutive ${wake.errors === 1 ? "run" : "runs"} could not complete (it fails after ${WAKE_LIMITS.check.maxConsecutiveErrors}); last: ${wake.lastError}.`)
  }
  if (wake.trigger.kind === "webhook" && webhookUrl !== undefined) lines.push(`URL: POST ${webhookUrl(wake.id)}`)
  lines.push(`Message: ${wake.message.length > 200 ? `${wake.message.slice(0, 200)}…` : wake.message}`)
  return lines
}

function result(status: "success" | "error", output: string, display: { action: string; id: string | null }): ToolResult {
  return { status, output, truncation: null, attachments: [], display: { wake: display } as Json }
}
