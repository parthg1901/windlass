/**
 * The line CLI's commands for the features the engine runs for a session
 * (`/mcp`, `/hooks`, `/lsp`, `/skills`, `/wakeups`, `/memory`, `/remember`,
 * `/forget`), and what it says about them unasked (`FeatureWatch`): an MCP
 * server, a hook or a language server the project's configuration names is
 * put to the user as a question at the prompt (or, in a run with nobody to
 * ask, counted in one sentence with how to approve them), a server that fails to start is a
 * notice with why, and a webhook wake-up's URL and secret are shown once
 * when it is created, to the user only.
 *
 * The words are `features.ts`'s and `hooks.ts`'s, shared with the TUI.
 */
import type { HookInfo, HooksStateResult, LspServerInfo, LspStateResult, McpServerInfo, McpStateResult, WakeRun } from "@windlass/acp/extensions"
import { type EngineEvent, type Session, turnOutcomeOf } from "./engine.ts"
import {
  type Line,
  mcpApprovedText,
  mcpFailureText,
  mcpLines,
  mcpNotWaitingText,
  mcpQuestionLines,
  memoryAction,
  memoryLines,
  rememberArgs,
  skillsLines,
  unapprovedText,
  WAKE_CHECK_ANSWERS,
  wakeAddEntry,
  wakeAddUsageLines,
  wakeCheckAccess,
  wakeCheckQuestionLines,
  wakeCreatedLines,
  wakeLines,
  wakeNotFiringText,
  watchEntry,
  watchLines,
  webhookSecretLines,
} from "./features.ts"
import { hookQuestionLines, hooksLines, lspLines, lspQuestionLines } from "./hooks.ts"

export interface FeatureOutput {
  lines(lines: readonly Line[]): void
  notice(text: string, tone?: "info" | "warn" | "error"): void
}

/** What the commands need: where to print, and how to ask (`null` where nobody can answer). */
export interface FeatureIo {
  readonly out: FeatureOutput
  /**
   * Puts a question at the prompt (`print` writes it, the first argument is the line of answers). `settle` is given
   * the answer (`null`: backed out of), does what it asks for and says what came of it; the next question waits for
   * it, so each confirmation is under its own question.
   */
  readonly ask: (<T>(question: string, print: () => void, settle: (answer: string | null) => T | Promise<T>) => Promise<T>) | null
  /** Whether a turn is running now: what is approved then is there from the next message, and that is said. */
  readonly working?: () => boolean
  /** Whether a webhook's secret may be printed: the output is a terminal the user reads. Default: it may. */
  readonly secrets?: boolean
  /** Keeps a note that cannot be saved before the session's first turn; it is saved, and said, once the session has started. */
  readonly keep?: (note: KeptNote) => void
}

/** A note written with `/remember` before the session's memory existed. */
export interface KeptNote {
  readonly text: string
  readonly scope: "user" | "project"
}

export const FEATURE_COMMANDS = ["mcp", "hooks", "lsp", "skills", "wakeups", "watch", "memory", "remember", "forget"] as const
export type FeatureCommand = (typeof FEATURE_COMMANDS)[number]

const MCP_ANSWERS = "[y] start it · [N] not now › "
const HOOK_ANSWERS = "[y] allow it · [N] not now › "
const LSP_ANSWERS = "[y] allow it · [N] not now › "

/** Runs one feature command to its end. Never throws: a failure is a line. */
export async function runFeatureCommand(name: FeatureCommand, rest: string, session: Session, io: FeatureIo): Promise<void> {
  const out = io.out
  const missing = (what: string) => out.notice(`/${what} is not available with this engine`, "warn")
  try {
    switch (name) {
      case "mcp": {
        if (session.mcp === undefined) return missing("mcp")
        const words = rest.trim().split(/\s+/).filter((word) => word !== "")
        if (words.length === 0) return out.lines(mcpLines(await session.mcp()))
        if (words[0] !== "approve" || words.length !== 2) return out.notice("/mcp takes nothing (the listing) or approve <server>", "warn")
        const state = await session.mcp()
        const server = state.servers.find((candidate) => candidate.name === words[1])
        if (server === undefined) return out.notice(`there is no MCP server "${words[1]}" in this session; /mcp lists them`, "warn")
        if (server.state !== "awaiting_approval" || server.question === null) return out.notice(mcpNotWaitingText(server))
        if (io.ask === null) return out.notice("nobody can answer here; run this interactively", "warn")
        return void (await askMcpServer(server, session, io))
      }
      case "hooks": {
        if (session.hooks === undefined) return missing("hooks")
        const words = rest.trim().split(/\s+/).filter((word) => word !== "")
        const state = await session.hooks()
        if (words.length === 0) return out.lines(hooksLines(state))
        if (words[0] !== "approve" || words.length !== 2) return out.notice("/hooks takes nothing (the listing) or approve <hook>", "warn")
        const named = state.hooks.filter((candidate) => candidate.name === words[1])
        if (named.length === 0) return out.notice(`there is no hook "${words[1]}" in this session; /hooks lists them`, "warn")
        const waiting = named.filter((hook) => hook.state === "awaiting_approval" && hook.question !== null)
        if (waiting.length === 0) return out.notice(`the hook "${words[1]}" does not wait for an approval: it is ${named[0]!.origin === "user" ? "your own and runs without one" : "approved already"}`)
        if (io.ask === null) return out.notice("nobody can answer here; run this interactively", "warn")
        for (const hook of waiting) await askHook(hook, session, io)
        return
      }
      case "lsp": {
        if (session.lsp === undefined) return missing("lsp")
        const words = rest.trim().split(/\s+/).filter((word) => word !== "")
        const state = await session.lsp()
        if (words.length === 0) return out.lines(lspLines(state))
        if (words[0] !== "approve" || words.length !== 2) return out.notice("/lsp takes nothing (the listing) or approve <server>", "warn")
        const server = state.servers.find((candidate) => candidate.name === words[1])
        if (server === undefined) return out.notice(`there is no language server "${words[1]}" in this session; /lsp lists them`, "warn")
        if (server.state !== "awaiting_approval" || server.question === null) return out.notice(`the language server "${server.name}" does not wait for an approval: it is ${server.state.replace(/_/g, " ")}`)
        if (io.ask === null) return out.notice("nobody can answer here; run this interactively", "warn")
        return void (await askLspServer(server, session, io))
      }
      case "skills":
        if (session.skills === undefined) return missing("skills")
        return out.lines(skillsLines(await session.skills()))
      case "wakeups": {
        if (session.wakeups === undefined) return missing("wakeups")
        const words = rest.trim().split(/\s+/).filter((word) => word !== "")
        if (words.length === 0) return out.lines(wakeLines(await session.wakeups()))
        if (words[0] === "add") return void (await addWake(rest.trim().slice("add".length), session, io))
        if (words.length !== 2 || (words[0] !== "cancel" && words[0] !== "secret")) return out.notice("/wakeups takes nothing (the listing), add <what> (/wakeups add shows the forms), cancel <id> or secret <id>", "warn")
        if (words[0] === "cancel") {
          const result = await session.cancelWake!(words[1]!)
          return out.notice(result.message, result.cancelled ? "info" : "warn")
        }
        return out.lines(webhookSecretLines(await session.wakeSecret!(words[1]!), false))
      }
      case "watch": {
        if (session.watches === undefined || session.watchOutput === undefined || session.unwatchOutput === undefined) return missing("watch")
        const entry = watchEntry(rest)
        if ("problem" in entry) return out.notice(entry.problem, "warn")
        if (entry.kind === "list") return out.lines(watchLines(await session.watches()))
        if (entry.kind === "remove") {
          // What was removed is the session's own event (`watch.ended`); one that is over or unknown is said here.
          if (!(await session.unwatchOutput(entry.watchId))) out.notice(`there is no watch ${entry.watchId} that could still fire (it has fired as often as it may, was removed, or its command ended); /watch lists them`, "warn")
          return
        }
        // A watch that was set is the session's own event (`watch.started`); a refusal is the engine's sentence.
        await session.watchOutput(entry.command, { pattern: entry.pattern, regex: entry.regex, ignoreCase: entry.ignoreCase, ...(entry.limit === null ? {} : { limit: entry.limit }) }).catch((error: unknown) => out.notice(error instanceof Error ? error.message : String(error), "warn"))
        return
      }
      case "memory": {
        if (session.memory === undefined) return missing("memory")
        const action = memoryAction(rest)
        if (action === null) return out.lines(memoryLines(await session.memory()))
        if ("problem" in action) return out.notice(action.problem, "warn")
        const result = await session.memoryChange!(action)
        return out.notice(result.message, result.ok ? "info" : "warn")
      }
      case "remember": {
        if (session.memoryChange === undefined) return missing("remember")
        const { text, scope } = rememberArgs(rest)
        if (text === "") return out.notice("/remember needs the note: /remember this repo uses pnpm (--me for a note about you, in every project)", "warn")
        const result = await session.memoryChange({ action: "remember", text, scope })
        // Memory starts with the session's first turn: the note is kept until then, never dropped.
        if (result.deferred === true && io.keep !== undefined) {
          io.keep({ text, scope })
          return out.notice(result.message)
        }
        return out.notice(result.message, result.ok ? "info" : "warn")
      }
      case "forget": {
        if (session.memoryChange === undefined) return missing("forget")
        const id = rest.trim()
        if (!/^m_\w+$/.test(id)) return out.notice("/forget needs a note's ID, as /memory lists them: /forget m_1a2b3c4d", "warn")
        const result = await session.memoryChange({ action: "retract", id })
        return out.notice(result.message, result.ok ? "info" : "warn")
      }
    }
  } catch (error) {
    out.notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/**
 * `/wakeups add ...`: the user sets a wake-up of their own. A check's
 * command is asked about first, like any command that would run: the
 * answer is the access it runs with, or that nothing is set up. What the
 * engine refuses is said in its sentence. A webhook's address and secret
 * are shown once, where the output is a terminal.
 */
async function addWake(rest: string, session: Session, io: FeatureIo): Promise<void> {
  const out = io.out
  if (session.createWake === undefined) return out.notice("/wakeups add is not available with this engine", "warn")
  if (rest.trim() === "") return out.lines(wakeAddUsageLines())
  const entry = wakeAddEntry(rest, Date.now())
  if ("problem" in entry) return out.notice(entry.problem, "warn")
  const create = async (run?: WakeRun): Promise<void> => {
    const result = await session.createWake!({ ...entry.request, ...(run === undefined ? {} : { run }) })
    if (!result.created || result.wake === null) return out.notice(result.message, "warn")
    out.lines(wakeCreatedLines(result))
    // A process that fires no wake-ups: said at once, with where this one will fire.
    if (!result.running) out.notice(wakeNotFiringText({ id: result.wake.id, description: result.wake.description }, session.id), "warn")
    if (result.secret === null) return
    // The secret is for the user's eyes, once: on a terminal only.
    if (io.secrets !== false) return out.lines(webhookSecretLines({ id: result.wake.id, url: result.url, secret: result.secret, message: null }, true))
    out.notice(`webhook wake-up ${result.wake.id} is at POST ${result.url}; its secret is not printed because this output is not a terminal. /wakeups secret ${result.wake.id} shows it there.`)
  }
  if (entry.check === null) return create()
  if (io.ask === null) return out.notice("nobody can answer here how the command may run; run this interactively", "warn")
  const check = entry.check
  return io.ask(WAKE_CHECK_ANSWERS, () => out.lines(wakeCheckQuestionLines(check)), (answer) => {
    const access = wakeCheckAccess(answer)
    return access === null ? out.notice("not set up: the command is not run") : create(access)
  })
}

const yes = (answer: string | null) => /^y(es)?$/i.test(answer?.trim() ?? "")

/** Puts the question about a project's server, and approves it on a yes. Resolves with whether it was approved. */
function askMcpServer(server: McpServerInfo, session: Session, io: FeatureIo): Promise<boolean> {
  return io.ask!(MCP_ANSWERS, () => io.out.lines(mcpQuestionLines(server)), async (answer) => {
    if (!yes(answer)) {
      io.out.notice(`not started; /mcp approve ${server.name} asks again`)
      return false
    }
    const approved = await session.approveMcp!(server.name, server.question!.fingerprint)
    io.out.notice(approved ? mcpApprovedText(server, io.working?.() === true) : `"${server.name}" no longer waits for an approval (its definition changed); /mcp shows it`, approved ? "info" : "warn")
    return approved
  })
}

/** Puts the question about a project's hook, and approves it on a yes. Resolves with whether it was approved. */
function askHook(hook: HookInfo, session: Session, io: FeatureIo): Promise<boolean> {
  return io.ask!(HOOK_ANSWERS, () => io.out.lines(hookQuestionLines(hook)), async (answer) => {
    if (!yes(answer)) {
      io.out.notice(`not allowed: the hook "${hook.name}" is not run; /hooks approve ${hook.name} asks again`)
      return false
    }
    const approved = await session.approveHook!(hook.fingerprint)
    io.out.notice(approved ? `approved: the hook "${hook.name}" runs from the next call it applies to; /hooks shows it` : `the hook "${hook.name}" no longer waits for an approval (its definition changed); /hooks shows it`, approved ? "info" : "warn")
    return approved
  })
}

/** Puts the question about a project's language server, and approves it on a yes. Resolves with whether it was approved. */
function askLspServer(server: LspServerInfo, session: Session, io: FeatureIo): Promise<boolean> {
  return io.ask!(LSP_ANSWERS, () => io.out.lines(lspQuestionLines(server)), async (answer) => {
    if (!yes(answer)) {
      io.out.notice(`not allowed: the language server "${server.name}" is not started; /lsp approve ${server.name} asks again`)
      return false
    }
    const approved = await session.approveLsp!(server.name, server.question!.fingerprint)
    io.out.notice(approved ? `approved: the language server "${server.name}" starts at the next file it serves; /lsp shows it` : `the language server "${server.name}" no longer waits for an approval (its definition changed); /lsp shows it`, approved ? "info" : "warn")
    return approved
  })
}

/** The wake-up a settled call created (`wake_create`'s `display.wake`), by its ID; `null` for any other event. */
export function createdWake(event: EngineEvent): string | null {
  if (event.type !== "tool.settled" || event.data.outcome !== "success") return null
  const wake = (event.data.display as { wake?: { action?: unknown; id?: unknown } } | null)?.wake
  return wake?.action === "create" && typeof wake.id === "string" ? wake.id : null
}

/**
 * What to say about a wake-up that was created where nothing fires
 * wake-ups (a one-prompt run ends with its turn): that it will not fire
 * here, and where it will. `null` when this process fires them, or the
 * engine cannot say.
 */
export async function wakeNotFiring(session: Session, id: string): Promise<string | null> {
  if (session.wakeups === undefined) return null
  const list = await session.wakeups().catch(() => null)
  if (list === null || !list.available || list.running) return null
  const wake = list.wakeups.find((candidate) => candidate.id === id)
  return wakeNotFiringText({ id, description: wake?.description ?? null }, session.id)
}

/**
 * `--json`: the one thing of what the CLI says unasked that a script has no
 * event for. A wake-up created in a run that fires none gets a line of the
 * CLI's own (`cli.notice`, kind `wake_not_firing`) after the call that
 * created it, with the sentence the pretty output prints.
 */
export class JsonNotices {
  private readonly work = new Set<Promise<unknown>>()

  constructor(
    private readonly session: Session,
    private readonly write: (notice: JsonNotice) => void,
  ) {}

  event(event: EngineEvent): void {
    const id = createdWake(event)
    if (id === null) return
    const told = wakeNotFiring(this.session, id).then(
      (message) => {
        if (message !== null) this.write({ type: "cli.notice", kind: "wake_not_firing", sessionId: this.session.id, wakeId: id, message })
      },
      () => {},
    )
    this.work.add(told)
    void told.finally(() => this.work.delete(told))
  }

  /** Resolves once every notice owed has been written. */
  async finish(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  stop(): void {}
}

/**
 * The CLI's own line in `--json` mode about something a script should know
 * and no engine event says. Not an engine event: its type is the CLI's, and
 * it is never stored.
 */
export interface JsonNotice {
  readonly type: "cli.notice"
  /** `wake_not_firing`: a wake-up was created in a run that fires none; it fires in the next process that runs the scheduler. */
  readonly kind: "wake_not_firing"
  readonly sessionId: string
  readonly wakeId: string
  /** The sentence the pretty output prints. */
  readonly message: string
}

/** How the engine's sentence about a project's hook or server that waits for the user's approval ends. */
const WAITS_FOR_APPROVAL = /runs only after you approve it\.$/

/** The kinds of thing a project's configuration names that run only once the user approved them. */
type Unapproved = "hooks" | "lsp" | "mcp"
const isUnapprovedKind = (kind: string): kind is Unapproved => kind === "hooks" || kind === "lsp" || kind === "mcp"

/**
 * What the CLI says about the features unasked, while a session is open.
 * `attended`: a person is at the prompt, so a project's server is asked
 * about; otherwise what waits for an approval is said once, in one sentence:
 * how many of each kind were not run and how to approve them (the engine's
 * own sentence about each is then not printed: `takes`). `secrets`: a
 * webhook's secret may be printed (the output is a terminal the user reads).
 * `draw`: how an event the watch held back is drawn after all.
 */
export class FeatureWatch {
  private readonly told = new Set<string>()
  private readonly asked = new Set<string>()
  private readonly work = new Set<Promise<unknown>>()
  private unsubscribe: (() => void) | null = null
  /** A turn is running. */
  private executing = false
  /** Notes written before the session's memory existed: saved once it has started. */
  private readonly notes: KeptNote[] = []
  /** With nobody to ask: the names of what waits for an approval, by kind; and of those, the ones not said yet. */
  private readonly skipped: Record<Unapproved, Set<string>> = { hooks: new Set(), lsp: new Set(), mcp: new Set() }
  private readonly unsaid: Record<Unapproved, Set<string>> = { hooks: new Set(), lsp: new Set(), mcp: new Set() }
  /** With nobody to ask: what the engine said about hooks and servers before the first look at them; `null` after it. */
  private held: EngineEvent[] | null = []
  private looks = 0

  constructor(
    private readonly session: Session,
    private readonly io: FeatureIo,
    private readonly options: { readonly attended: boolean; readonly secrets: boolean; readonly draw?: (event: EngineEvent) => void },
  ) {}

  /** Whether someone is there to answer a question. */
  private get attended(): boolean {
    return this.options.attended && this.io.ask !== null
  }

  start(): void {
    const off = [this.session.onMcp?.((state) => this.mcp(state)), this.session.onHooks?.((state) => this.hooks(state)), this.session.onLsp?.((state) => this.lsp(state))]
    this.unsubscribe = () => off.forEach((each) => each?.())
  }

  /** Whether a turn is running, as the session's events say. */
  get working(): boolean {
    return this.executing
  }

  /**
   * Before a message is sent that starts a turn, with someone at the prompt:
   * whatever of the project's configuration waits for an approval (a hook, a
   * language server, an MCP server the engine has looked at) is asked about
   * now, and answered, so the turn starts with what the user allowed and no
   * question interrupts it. Before a session's first message the engine has
   * not looked at the MCP servers yet: a project's are named, with what to
   * expect.
   */
  async beforeMessage(): Promise<void> {
    if (!this.attended) return this.look()
    await this.read()
    await this.settled()
  }

  /** Reads the session's hooks, language servers and MCP servers as they are now, and takes note of each. */
  private async read(): Promise<void> {
    const session = this.session
    const look = async <T>(read: (() => Promise<T>) | undefined, tell: (state: T) => void) => {
      const state = read === undefined ? undefined : await read.call(session).catch(() => undefined)
      if (state !== undefined) tell(state)
    }
    await look(session.hooks, (state) => this.hooks(state))
    await look(session.lsp, (state) => this.lsp(state))
    await look(session.mcp, (state) => this.mcp(state))
  }

  /**
   * With nobody to ask: looks at what the project's configuration names and nobody approved, says it in one
   * sentence, and draws what the engine said meanwhile about anything else.
   */
  private async look(): Promise<void> {
    this.looks += 1
    try {
      await this.read()
    } finally {
      this.looks -= 1
    }
    const held = this.held ?? []
    this.held = null
    this.sayUnapproved()
    for (const event of held) if (!this.aboutSkipped(event)) this.options.draw?.(event)
  }

  /** The one sentence about what was not run for want of an approval; nothing before the first look is done. */
  private sayUnapproved(): void {
    if (this.looks > 0 || this.held !== null) return
    const counts = { hooks: this.unsaid.hooks.size, lsp: this.unsaid.lsp.size, mcp: this.unsaid.mcp.size }
    if (counts.hooks + counts.lsp + counts.mcp === 0) return
    for (const names of Object.values(this.unsaid)) names.clear()
    this.io.out.notice(unapprovedText(counts), "warn")
  }

  private skip(kind: Unapproved, names: readonly string[]): void {
    for (const name of names) {
      this.skipped[kind].add(name)
      this.unsaid[kind].add(name)
    }
    this.sayUnapproved()
  }

  /** Whether `event` is the engine's sentence about a hook or a server that the one sentence here covers. */
  private aboutSkipped(event: EngineEvent): boolean {
    if (event.type !== "diagnostic" || !isUnapprovedKind(event.kind)) return false
    return [...this.skipped[event.kind]].some((name) => event.message.includes(`"${name}"`))
  }

  /**
   * Whether the watch answers for `event` itself, so that it is not drawn as it comes. With nobody to ask, what
   * the engine says about a project's hook or server that waits for an approval is one line each, with its whole
   * command: the one sentence of `look` stands for them all. What it says about anything else is drawn.
   */
  takes(event: EngineEvent): boolean {
    if (event.type !== "diagnostic" || !isUnapprovedKind(event.kind)) return false
    // With someone to ask, the question about it (put from `event`) says all of it, its command included: once.
    if (this.attended) return WAITS_FOR_APPROVAL.test(event.message)
    if (this.held === null) return this.aboutSkipped(event)
    this.held.push(event)
    return true
  }

  /** Every event of the session, after the renderer has shown it. */
  event(event: EngineEvent): void {
    if (event.type === "execution.started" || event.type === "execution.resumed") this.executing = true
    // The session has started: its memory exists from here on, and what `/remember` kept is saved.
    if (event.type === "baseline.set" && this.notes.length > 0) this.track(this.saveKept())
    if (turnOutcomeOf(event) !== null) this.executing = false
    // The engine says a project's server was not started: the question (or how to approve it) follows at once.
    if (event.type === "diagnostic" && event.kind === "mcp" && this.session.mcp !== undefined) this.track(this.session.mcp().then((state) => this.mcp(state)))
    // So for a hook or a language server it did not run: asked about at once, or said how to approve.
    if (event.type === "diagnostic" && event.kind === "hooks" && this.session.hooks !== undefined) this.track(this.session.hooks().then((state) => this.hooks(state)))
    if (event.type === "diagnostic" && event.kind === "lsp" && this.session.lsp !== undefined) this.track(this.session.lsp().then((state) => this.lsp(state)))
    const wake = createdWake(event)
    if (wake !== null) this.track(this.created(wake))
  }

  /** A note `/remember` could not save yet: kept until the session's first turn has started. */
  keep(note: KeptNote): void {
    this.notes.push(note)
  }

  /** The kept notes, saved now that the session has its memory; what became of each is said. */
  private async saveKept(): Promise<void> {
    const change = this.session.memoryChange
    if (change === undefined) return
    for (const note of this.notes.splice(0)) {
      const result = await change.call(this.session, { action: "remember", text: note.text, scope: note.scope }).catch((error: unknown) => ({ ok: false, id: null, message: error instanceof Error ? error.message : String(error) }))
      this.io.out.notice(`your note from before the first message: ${result.message}`, result.ok ? "info" : "warn")
    }
  }

  /** At the end of a run with nobody to ask: what became of the servers, said once. */
  async finish(): Promise<void> {
    // A note that waited for a first message that never came was not saved: said, never dropped silently.
    for (const note of this.notes.splice(0)) this.io.out.notice(`not saved: no message was sent in this session, and its memory starts with the first one. Your note was: ${note.text}`, "warn")
    if (!this.attended) await this.track(this.look())
    await this.settled()
  }

  /** Resolves once what was started on the user's behalf (a secret fetched, a question put) is done. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private track<T>(work: Promise<T>): Promise<T | undefined> {
    const tracked = work.catch(() => undefined)
    this.work.add(tracked)
    void tracked.finally(() => this.work.delete(tracked))
    return tracked
  }

  /** A wake-up created where nothing fires wake-ups (a one-prompt run): said once, with where it will fire. */
  private async notFiring(id: string): Promise<void> {
    const text = await wakeNotFiring(this.session, id)
    if (text !== null) this.io.out.notice(text, "warn")
  }

  private mcp(state: McpStateResult): void {
    for (const server of state.servers) {
      if (server.state === "failed" && server.error !== null) {
        const key = `failed:${server.name}:${server.error}`
        if (this.told.has(key)) continue
        this.told.add(key)
        this.io.out.notice(mcpFailureText(server), "warn")
      }
      if (server.state === "awaiting_approval" && server.question !== null) {
        const key = `${server.name}:${server.question.fingerprint}`
        if (this.asked.has(key)) continue
        this.asked.add(key)
        if (this.attended) this.track(askMcpServer(server, this.session, this.io))
        else this.skip("mcp", [server.name])
      }
    }
  }

  /** The project's hooks that wait: each is a question at the prompt, one after another; with nobody to ask, they are counted (`look`). */
  private hooks(state: HooksStateResult): void {
    const fresh = state.hooks.filter((hook) => hook.state === "awaiting_approval" && hook.question !== null && !this.asked.has(`hook:${hook.fingerprint}`))
    if (fresh.length === 0) return
    for (const hook of fresh) this.asked.add(`hook:${hook.fingerprint}`)
    if (!this.attended) return this.skip("hooks", fresh.map((hook) => hook.name))
    this.track(
      (async () => {
        for (const hook of fresh) await askHook(hook, this.session, this.io)
      })(),
    )
  }

  /** A project's language server that waits is a question at the prompt; one that failed to start is a notice with why. */
  private lsp(state: LspStateResult): void {
    const fresh = state.servers.filter((server) => server.state === "awaiting_approval" && server.question !== null && !this.asked.has(`lsp:${server.name}:${server.question.fingerprint}`))
    if (fresh.length === 0) return
    for (const server of fresh) this.asked.add(`lsp:${server.name}:${server.question!.fingerprint}`)
    if (!this.attended) return this.skip("lsp", fresh.map((server) => server.name))
    this.track(
      (async () => {
        for (const server of fresh) await askLspServer(server, this.session, this.io)
      })(),
    )
  }

  private async created(id: string): Promise<void> {
    await this.notFiring(id)
    if (this.session.wakeSecret === undefined) return
    const secret = await this.session.wakeSecret(id)
    // Not a webhook: there is nothing to show.
    if (secret.secret === null) return
    if (this.options.secrets) return this.io.out.lines(webhookSecretLines(secret, true))
    this.io.out.notice(`webhook wake-up ${id} is at POST ${secret.url}; its secret is not printed because this output is not a terminal. Open the session (\`--session ${this.session.id}\`) and type /wakeups secret ${id} to see it.`)
  }
}
