/**
 * Wake-ups, as the engine offers them (`wake/` has the module).
 *
 * - `wake_create`, `wake_list` and `wake_cancel` are in a session's frozen
 *   tool list from its first baseline when wake-ups are enabled at that
 *   moment (`wake.enabled`, on unless a file turns it off), for a session a
 *   person started; a subagent is not offered them. Their specs are constants.
 * - A firing reaches the session through its inbox, admitted with the
 *   firing's own key as the message ID (`EngineSession.admit`), so a firing
 *   delivered twice is one message. One that carries content from outside
 *   the harness is recorded as such with the admission, and taints the
 *   session from there on.
 * - `wake_create` is decided by the approval layer exactly as a shell command
 *   is (its input has the shell's `command` and `sandbox`), and what it was
 *   allowed to run under is the most its check may ever run with.
 *
 * **Which processes fire wake-ups.** Every process that offers the tools can
 * create, list and cancel wake-ups: they are records in a store all processes
 * of a data directory share. Only a process told to (`WakeSetup.run`) runs
 * the scheduler and the webhook listener: the long-lived ones, which is the
 * ACP server. A one-prompt run does not: it would fire wake-ups of other
 * sessions, start turns in them, and cut those turns off when it exits a
 * moment later, and it must not open a port. A wake-up created in such a run
 * is not lost: it fires in the next process that runs the scheduler, late if
 * need be, as the wake module's rules for missed times say.
 *
 * **The configuration.** The store, the scheduler and the listener are one
 * per process, so what configures them is the user's own file: where the
 * listener binds, the hourly ceiling, the model's limit of pending wake-ups.
 * A project's file can only tighten, per session: it can turn the tools off
 * for sessions in it and lower the model's limit there. Its lower hourly
 * ceiling is not applied (the ceiling is kept by the shared store).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseConfigFile } from "../config/schema.ts"
import type { CommandSandbox } from "../sandbox/command.ts"
import type { AnyTool, ToolContext, ToolResult } from "../tool/tool.ts"
import { type CheckRunner, createCheckRunner } from "../wake/check.ts"
import { type WakeClock, systemClock } from "../wake/clock.ts"
import { type WakeConfig, type WakeConfigSection, resolveWakeConfig } from "../wake/config.ts"
import { type RunAs, type WakeUp, WAKE_LIMITS, duration } from "../wake/record.ts"
import { type Deliver, type Scheduler, type SchedulerOptions, createScheduler } from "../wake/scheduler.ts"
import { type WakeStore, type WakeStoreOptions, openWakeStore, wakeDirectory } from "../wake/store.ts"
import { type CreateInput, describeLines, wakeTools } from "../wake/tools.ts"
import { type WebhookListener, createWebhookListener } from "../wake/webhook.ts"
import type { ConfigFiles } from "./skills.ts"

/** How an engine is told to offer wake-ups. Everything has a default; tests pass their own. */
export interface WakeSetup {
  /**
   * Whether this process fires wake-ups: runs the scheduler, and the webhook
   * listener while a webhook wake-up exists. Default `false`: the tools work
   * (they write records), and another process fires what they set up.
   */
  readonly run?: boolean
  /** With `run`: whether the webhook listener runs too. Default `true`. */
  readonly listener?: boolean
  /** The user's `wake` section, instead of the one in the user's configuration file. */
  readonly config?: WakeConfigSection
  /** Default: the system clock. */
  readonly clock?: WakeClock
  readonly scheduler?: Pick<SchedulerOptions, "maxIdleMs" | "probeMs" | "stopGraceMs" | "maxConcurrentChecks" | "onEvent">
  readonly store?: Pick<WakeStoreOptions, "leaseMs" | "busyTimeoutMs">
  /** Runs a check, instead of the module's runner (which uses the shell tool and the sandbox). */
  readonly runCheck?: CheckRunner
  /** The listener's port, instead of the configuration's: `0` picks a free one (tests). */
  readonly port?: number
}

/** What a client uses to show, create and cancel wake-ups (`wake/README.md`, "Clients"). */
export interface WakeApi {
  /** The process's configuration: the user's own file with the defaults applied. */
  readonly config: WakeConfig
  /** The shared store: `list`, `get`, `create` (with `author: "user"`), `cancel` (`by: "user"`), `secret`, `firings`. */
  readonly store: WakeStore
  /** Where a webhook wake-up receives requests. */
  readonly webhookUrl: (wakeId: string) => string
  /** The state, the next time and every limit of a wake-up, one fact per line. */
  readonly describe: (wake: WakeUp) => string[]
  /** After a client created or cancelled a wake-up: the scheduler and the listener look again. */
  readonly changed: () => void
  /** Whether this process fires wake-ups. */
  readonly running: boolean
}

export interface WakeRuntimeOptions {
  readonly dataDir: string
  readonly setup: WakeSetup
  readonly config: WakeConfig
  /** The sandbox checks run in; `null` when the engine has no approval layer (then a sandboxed check cannot run). */
  readonly sandbox: (() => CommandSandbox) | null
  readonly secrets: () => readonly string[]
  readonly deliver: Deliver
  readonly currentRun: NonNullable<SchedulerOptions["currentRun"]>
  readonly warn: (message: string) => void
}

/** The wake store of a process with, when the process fires wake-ups, its scheduler and listener. */
export class WakeRuntime implements WakeApi {
  readonly config: WakeConfig
  readonly store: WakeStore
  readonly running: boolean
  private readonly scheduler: Scheduler | null
  private readonly listener: WebhookListener | null
  private readonly port: number
  private stopped: Promise<void> | null = null

  constructor(options: WakeRuntimeOptions) {
    const { setup, config } = options
    const clock = setup.clock ?? systemClock
    this.config = config
    this.port = setup.port ?? config.webhook.port
    this.store = openWakeStore({ dir: wakeDirectory(options.dataDir), clock, hourlyCeiling: config.hourlyCeiling, maxActive: { model: config.maxActive }, ...setup.store })
    this.running = setup.run === true && config.enabled
    if (!this.running) {
      this.scheduler = null
      this.listener = null
      return
    }
    const sandbox = options.sandbox
    this.scheduler = createScheduler({
      store: this.store,
      clock,
      runCheck: setup.runCheck ?? createCheckRunner({ spillDir: join(wakeDirectory(options.dataDir), "spill"), ...(sandbox === null ? {} : { sandbox: sandbox() }), secrets: options.secrets }),
      deliver: options.deliver,
      currentRun: options.currentRun,
      ...setup.scheduler,
    })
    this.listener =
      setup.listener === false
        ? null
        : createWebhookListener({
            store: this.store,
            clock,
            host: config.webhook.host,
            port: this.port,
            allowExternal: config.webhook.allowExternal,
            maxBodyBytes: config.webhook.maxBodyBytes,
            requestsPerMinute: config.webhook.requestsPerMinute,
            onFiring: this.scheduler.poke,
            warn: options.warn,
            secrets: options.secrets,
          })
    for (const ignored of config.ignored) options.warn(ignored)
    this.scheduler.start()
    this.listener?.start()
  }

  webhookUrl = (wakeId: string): string => {
    // The address the listener really has, when it listens (a test's free port); the configured one otherwise.
    const base = this.listener?.url() ?? `http://${this.config.webhook.host}:${this.port}`
    return `${base}/w/${wakeId}`
  }

  describe = (wake: WakeUp): string[] => describeLines(wake, this.store.hourlyCeiling, this.webhookUrl)

  changed = (): void => {
    this.scheduler?.poke()
    this.listener?.refresh()
  }

  /** One pass of the scheduler at the clock's current time, for tests: resolves when everything due was fired and delivered. */
  runDue(): Promise<void> {
    return this.scheduler?.runDue() ?? Promise.resolve()
  }

  /** No firing is delivered and no check runs from here on. The store stays open for the sessions that are still closing. */
  quiesce(): Promise<void> {
    this.stopped ??= (async () => {
      await this.listener?.stop()
      await this.scheduler?.stop()
    })()
    return this.stopped
  }

  /** After `quiesce`, once nothing can call a wake tool any more. */
  close(): void {
    try {
      this.store.close()
    } catch {
      // Closed already.
    }
  }
}

/** The `wake` section of the user's own configuration file, or `undefined` when there is none or it cannot be read (then `problem` says why). */
export function readUserWakeSection(configDir: string): { readonly section: WakeConfigSection | undefined; readonly problem: string | null } {
  const path = join(configDir, "config.json")
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { section: undefined, problem: null }
  }
  try {
    return { section: parseConfigFile(text, path).wake, problem: null }
  } catch (error) {
    return { section: undefined, problem: error instanceof Error ? error.message : String(error) }
  }
}

/** A session's wake-up settings: the user's, tightened by the project's file. */
export function sessionWakeConfig(files: ConfigFiles | null, user: WakeConfigSection | undefined): WakeConfig {
  return resolveWakeConfig(files?.user?.wake ?? user, files?.project?.wake)
}

export interface WakeToolHost {
  readonly runtime: () => WakeRuntime
  readonly now: () => number
  /** Whether the calling session has taken in untrusted content. */
  readonly tainted: (context: ToolContext) => boolean
  readonly seqOf: (context: ToolContext) => number | null
  /** The calling session's settings, or `null` when the session is not open here. */
  readonly configOf: (context: ToolContext) => WakeConfig | null
}

/**
 * The wake tools of an engine. One set for every session: the specs are the
 * module's constants. `wake_create` says, for the question the approval
 * layer may put, that what it sets up runs later and unattended, and honours
 * what the calling session's project tightened.
 */
export function engineWakeTools(host: WakeToolHost): AnyTool[] {
  const [create, list, cancel] = wakeTools({
    store: () => host.runtime().store,
    sessionTainted: host.tainted,
    seqOf: host.seqOf,
    webhookUrl: (id) => host.runtime().webhookUrl(id),
    changed: () => host.runtime().changed(),
    now: host.now,
  })
  const refused = (output: string): ToolResult => ({ status: "error", output, truncation: null, attachments: [], display: { wake: { action: "create", id: null } } })
  const guarded = {
    ...create,
    cautions: (input: CreateInput) => createCautions(input),
    execute: async (input: CreateInput, context: ToolContext) => {
      const config = host.configOf(context)
      if (config !== null && !config.enabled) return refused("Wake-ups are turned off in the configuration that applies here. Nothing was set up.")
      if (config !== null) {
        const pending = host.runtime().store.list({ sessionId: context.sessionId }).filter((wake) => wake.provenance.author === "model").length
        if (pending >= config.maxActive)
          return refused(`This session already has ${pending} pending wake-ups, the most the configuration that applies here allows (${config.maxActive}). Cancel one with wake_cancel first.`)
      }
      return create.execute(input, context)
    },
  }
  return [guarded as unknown as AnyTool, list as unknown as AnyTool, cancel as unknown as AnyTool]
}

/** What the user should know before approving a `wake_create` call: that it acts later, with nobody watching, and how often. */
export function createCautions(input: CreateInput): string[] {
  const times = (() => {
    if (input.trigger === "at" || input.trigger === "after" || (input.trigger === "check" && input.fire === "until")) return "once"
    const most = typeof input.maxFirings === "number" ? input.maxFirings : WAKE_LIMITS.model.maxFirings.default
    return `up to ${most} times`
  })()
  const seconds = typeof input.seconds === "number" && input.seconds > 0 ? duration(input.seconds * 1000) : null
  const when =
    input.trigger === "at"
      ? `at ${String(input.at)}`
      : input.trigger === "after"
        ? `after ${seconds ?? "a delay"}`
        : input.trigger === "every"
          ? `every ${seconds ?? "interval"}`
          : input.trigger === "cron"
            ? `on the schedule ${String(input.cron)}`
            : input.trigger === "check"
              ? `when this command ${input.fire === "on_change" ? "changes its output" : "exits 0"}, run every ${seconds ?? "interval"}`
              : "when a signed webhook request arrives"
  return [
    `This sets up a wake-up that fires ${when}, ${times}. It starts a turn in this session later, when nobody may be watching.`,
    ...(input.trigger === "check" ? ["The command runs again and again by itself, with no model call and no question, under exactly what you allow now."] : []),
  ]
}

/** The run the approval layer would let a session's commands have now, as the scheduler asks before every check. */
export function runAllowedNow(wake: WakeUp, now: { readonly mode: "ask" | "auto" | "full"; readonly tainted: boolean } | null): RunAs | null {
  // No approval layer: nothing narrows what was recorded.
  if (now === null) return null
  // Untrusted content is in the conversation: every command is sandboxed and offline, whatever was granted before.
  if (now.tainted) return { kind: "sandboxed", network: false, writableRoots: [] }
  if (now.mode === "full") return null
  // Commands are sandboxed now. What was approved for this check when it was created stands; a check that was let
  // run without the sandbox (the mode was `full` then) gets the sandbox and nothing more.
  return wake.run?.kind === "sandboxed" ? wake.run : { kind: "sandboxed", network: false, writableRoots: [] }
}
