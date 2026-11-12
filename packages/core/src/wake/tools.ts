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

/**
 * What the model needs to call the tool correctly, and no more: this text is in every request of every session.
 * The details of each trigger (the limits, the defaults, what a check runs with) are in `TRIGGER_HELP`, which a
 * call that is not valid is answered with, and the limits that apply are stated in every successful result.
 */
const CREATE_DESCRIPTION = [
  "Have a message delivered to this session later, as a new turn; waiting costs no model call. Use it instead of sleeping or polling when the wait is longer than a couple of minutes or may outlast this turn (CI, a deploy, a reminder, a retry); for a shorter wait, run the command instead.",
  '`trigger`: "after" `seconds`; "at" the time `at`; "every" `seconds`; "cron"; "check" runs `command` every `seconds` and fires when it exits 0 (`fire: "until"`) or when its output changes ("on_change"); "webhook" fires on a signed HTTP request.',
  "Nobody may be watching when it fires: write `message` for yourself, and tell the user what you set up. An invalid call is answered with what to fix.",
].join(" ")

/** The reference for one trigger: what the description used to carry for every request, said when a call needs it. */
const TRIGGER_HELP: Readonly<Record<CreateInput["trigger"], string>> = {
  at: 'An "at" wake-up fires once at `at`, an ISO 8601 time with an offset or Z, e.g. {"trigger":"at","at":"2026-11-12T17:00:00+01:00","message":"..."}.',
  after: 'An "after" wake-up fires once, `seconds` from now, e.g. {"trigger":"after","seconds":600,"message":"..."}.',
  every: `An "every" wake-up fires every \`seconds\` (at least 60), up to \`maxFirings\` times (default ${M.maxFirings.default}, at most ${M.maxFirings.max}), e.g. {"trigger":"every","seconds":600,"maxFirings":6,"message":"..."}.`,
  cron: 'A "cron" wake-up takes a five-field expression in `cron` ("minute hour day month weekday", e.g. "0 9 * * mon-fri"), read in `timeZone` (an IANA zone such as "Europe/Berlin") or else the user\'s time zone.',
  check:
    'A "check" wake-up runs `command` every `seconds` (at least 15) in the working directory, without a model call. `fire: "until"` fires once, the first time the command exits 0 (e.g. `gh run view 123 --exit-status`); `fire: "on_change"` fires each time its output or exit code differs from the run before. One run is stopped after `timeoutSeconds` (default 60, or the interval if shorter). Its output is in the message unless `includeOutput` is false. It runs as your shell commands do: in the sandbox, without network, unless you ask for more with `sandbox` (the user is asked now, and it never gets more later). Example: {"trigger":"check","command":"gh run view 123 --exit-status","seconds":120,"fire":"until","message":"..."}.',
  webhook:
    'A "webhook" wake-up fires when an HTTP request signed with its secret arrives at its local URL. The secret is shown to the user, not to you. The request body is in the message, as untrusted content, unless `includeBody` is false. Example: {"trigger":"webhook","message":"..."}.',
}

/** What every wake-up can also say, whatever its trigger. */
const COMMON_HELP = `Any wake-up: \`delivery\` "wake" (default) starts a turn if the session is idle, otherwise after the current turn, and "queue" only waits for the next turn; it expires after \`expiresInSeconds\` (default ${M.expiry.defaultMs / 3_600_000} hours, at most ${M.expiry.maxMs / 86_400_000} days); at least \`minIntervalSeconds\` pass between two firings (default ${WAKE_LIMITS.minInterval.defaultMs / 1000}); a session has at most ${M.maxActive} pending wake-ups and receives a fixed number of firings per hour.`

/** The answer to a call that is not valid: what is wrong, then how that trigger is written. */
function invalid(problem: string, trigger: CreateInput["trigger"] | undefined): string {
  const known = trigger !== undefined && Object.hasOwn(TRIGGER_HELP, trigger)
  return [`The wake-up was not created: ${problem}`, known ? TRIGGER_HELP[trigger] : `Triggers: ${Object.values(TRIGGER_HELP).join(" ")}`, COMMON_HELP].join("\n")
}

/** The shell's `sandbox` argument without its prose: the same shape, so the approval layer reads it the same way. */
const SANDBOX_SCHEMA = {
  type: "object",
  description: "More access for the check, as for shell.",
  properties: { network: { type: "boolean" }, write: { type: "array", items: { type: "string", minLength: 1 }, maxItems: escalationSchema.properties.write.maxItems } },
  additionalProperties: false,
} as const

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
        message: { type: "string", minLength: 1, maxLength: WAKE_LIMITS.messageChars, description: "What to do when it fires, with the context you will need then." },
        trigger: { type: "string", enum: ["at", "after", "every", "cron", "check", "webhook"] },
        at: { type: "string", description: 'ISO 8601 with an offset, e.g. "2026-11-12T17:00:00+01:00".' },
        seconds: { type: "integer", minimum: 1 },
        cron: { type: "string", description: 'Five fields, e.g. "0 9 * * mon-fri".' },
        timeZone: { type: "string", description: "For cron; default: the user's." },
        command: { type: "string", minLength: 1, maxLength: WAKE_LIMITS.commandChars },
        fire: { type: "string", enum: ["until", "on_change"] },
        timeoutSeconds: { type: "integer", minimum: 1, maximum: WAKE_LIMITS.check.timeout.maxMs / 1000 },
        includeOutput: { type: "boolean" },
        sandbox: SANDBOX_SCHEMA,
        includeBody: { type: "boolean" },
        delivery: { type: "string", enum: ["wake", "queue"] },
        maxFirings: { type: "integer", minimum: 1, maximum: M.maxFirings.max },
        expiresInSeconds: { type: "integer", minimum: 60, maximum: M.expiry.maxMs / 1000 },
        minIntervalSeconds: { type: "integer", minimum: WAKE_LIMITS.minInterval.minMs / 1000 },
      },
      required: ["message", "trigger"],
      additionalProperties: false,
    },
    effect: "exec",
    execute: async (input, context) => {
      const now = (options.now ?? Date.now)()
      const trigger = triggerOf(input, options.timeZone)
      if (typeof trigger === "string") return result("error", invalid(trigger, input.trigger), { action: "create", id: null })
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
      // A session that is full is told only that; a call that is wrong is told how the trigger is written.
      if (!created.ok) return result("error", created.limit === true ? created.error : invalid(created.error, input.trigger), { action: "create", id: null })
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
    // The wake-up store is the harness's own: nothing in the workspace changes.
    changes: "records",
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
      return `"${String((input as { trigger: unknown }).trigger)}" is not a trigger.`
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
