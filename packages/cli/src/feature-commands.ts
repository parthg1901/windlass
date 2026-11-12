/**
 * The line CLI's commands for the features the engine runs for a session
 * (`/mcp`, `/hooks`, `/lsp`, `/skills`, `/wakeups`, `/memory`, `/remember`,
 * `/forget`), and what it says about them unasked (`FeatureWatch`): an MCP
 * server, a hook or a language server the project's configuration names is
 * put to the user as a question at the prompt (or, in a run with nobody to
 * ask, said once with how to approve it), a server that fails to start is a
 * notice with why, and a webhook wake-up's URL and secret are shown once
 * when it is created, to the user only.
 *
 * The words are `features.ts`'s and `hooks.ts`'s, shared with the TUI.
 */
import type { HookInfo, HooksStateResult, LspServerInfo, LspStateResult, McpServerInfo, McpStateResult } from "@windlass/acp/extensions"
import { type EngineEvent, type Session, turnOutcomeOf } from "./engine.ts"
import {
  type Line,
  mcpApprovedText,
  mcpFailureText,
  mcpFirstMessageText,
  mcpLines,
  mcpNotWaitingText,
  mcpQuestionLines,
  mcpUnattendedText,
  memoryAction,
  memoryLines,
  rememberArgs,
  skillsLines,
  wakeLines,
  webhookSecretLines,
} from "./features.ts"
import { hookQuestionLines, hooksLines, hooksUnattendedText, lspLines, lspQuestionLines, lspUnattendedText } from "./hooks.ts"

export interface FeatureOutput {
  lines(lines: readonly Line[]): void
  notice(text: string, tone?: "info" | "warn" | "error"): void
}

/** What the commands need: where to print, and how to ask (`null` where nobody can answer). */
export interface FeatureIo {
  readonly out: FeatureOutput
  readonly ask: ((question: string, print: () => void) => Promise<string | null>) | null
  /** Whether a turn is running now: what is approved then is there from the next message, and that is said. */
  readonly working?: () => boolean
}

export const FEATURE_COMMANDS = ["mcp", "hooks", "lsp", "skills", "wakeups", "memory", "remember", "forget"] as const
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
        if (words.length !== 2 || (words[0] !== "cancel" && words[0] !== "secret")) return out.notice("/wakeups takes nothing (the listing), cancel <id> or secret <id>", "warn")
        if (words[0] === "cancel") {
          const result = await session.cancelWake!(words[1]!)
          return out.notice(result.message, result.cancelled ? "info" : "warn")
        }
        return out.lines(webhookSecretLines(await session.wakeSecret!(words[1]!), false))
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

/** Puts the question about a project's server, and approves it on a yes. Resolves with whether it was approved. */
async function askMcpServer(server: McpServerInfo, session: Session, io: FeatureIo): Promise<boolean> {
  const answer = (await io.ask!(MCP_ANSWERS, () => io.out.lines(mcpQuestionLines(server))))?.trim().toLowerCase() ?? ""
  if (answer !== "y" && answer !== "yes") {
    io.out.notice(`not started; /mcp approve ${server.name} asks again`)
    return false
  }
  const approved = await session.approveMcp!(server.name, server.question!.fingerprint)
  io.out.notice(approved ? mcpApprovedText(server, io.working?.() === true) : `"${server.name}" no longer waits for an approval (its definition changed); /mcp shows it`, approved ? "info" : "warn")
  return approved
}

/** Puts the question about a project's hook, and approves it on a yes. Resolves with whether it was approved. */
async function askHook(hook: HookInfo, session: Session, io: FeatureIo): Promise<boolean> {
  const answer = (await io.ask!(HOOK_ANSWERS, () => io.out.lines(hookQuestionLines(hook))))?.trim().toLowerCase() ?? ""
  if (answer !== "y" && answer !== "yes") {
    io.out.notice(`not allowed: the hook "${hook.name}" is not run; /hooks approve ${hook.name} asks again`)
    return false
  }
  const approved = await session.approveHook!(hook.fingerprint)
  io.out.notice(approved ? `approved: the hook "${hook.name}" runs from the next call it applies to; /hooks shows it` : `the hook "${hook.name}" no longer waits for an approval (its definition changed); /hooks shows it`, approved ? "info" : "warn")
  return approved
}

/** Puts the question about a project's language server, and approves it on a yes. Resolves with whether it was approved. */
async function askLspServer(server: LspServerInfo, session: Session, io: FeatureIo): Promise<boolean> {
  const answer = (await io.ask!(LSP_ANSWERS, () => io.out.lines(lspQuestionLines(server))))?.trim().toLowerCase() ?? ""
  if (answer !== "y" && answer !== "yes") {
    io.out.notice(`not allowed: the language server "${server.name}" is not started; /lsp approve ${server.name} asks again`)
    return false
  }
  const approved = await session.approveLsp!(server.name, server.question!.fingerprint)
  io.out.notice(approved ? `approved: the language server "${server.name}" starts at the next file it serves; /lsp shows it` : `the language server "${server.name}" no longer waits for an approval (its definition changed); /lsp shows it`, approved ? "info" : "warn")
  return approved
}

/**
 * What the CLI says about the features unasked, while a session is open.
 * `attended`: a person is at the prompt, so a project's server is asked
 * about; otherwise it is said once how to approve it. `secrets`: a webhook's
 * secret may be printed (the output is a terminal the user reads).
 */
export class FeatureWatch {
  private readonly told = new Set<string>()
  private readonly asked = new Set<string>()
  private readonly work = new Set<Promise<unknown>>()
  private unsubscribe: (() => void) | null = null
  /** A turn is running; and whether the session has had one (its servers are looked at when the first starts). */
  private executing = false
  private started = false

  constructor(
    private readonly session: Session,
    private readonly io: FeatureIo,
    private readonly options: { readonly attended: boolean; readonly secrets: boolean },
  ) {}

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
    if (!this.options.attended || this.io.ask === null) return
    const session = this.session
    const look = async <T>(read: (() => Promise<T>) | undefined, tell: (state: T) => void) => {
      const state = read === undefined ? undefined : await read.call(session).catch(() => undefined)
      if (state !== undefined) tell(state)
    }
    await look(session.hooks, (state) => this.hooks(state))
    await look(session.lsp, (state) => this.lsp(state))
    await look(session.mcp, (state) => {
      this.mcp(state)
      const first = this.started || this.told.has("first-message") ? null : mcpFirstMessageText(state.servers)
      this.told.add("first-message")
      if (first !== null) this.io.out.notice(first)
    })
    await this.settled()
  }

  /** Every event of the session, after the renderer has shown it. */
  event(event: EngineEvent): void {
    if (event.type === "execution.started" || event.type === "execution.resumed") this.executing = this.started = true
    if (turnOutcomeOf(event) !== null) this.executing = false
    // The engine says a project's server was not started: the question (or how to approve it) follows at once.
    if (event.type === "diagnostic" && event.kind === "mcp" && this.session.mcp !== undefined) this.track(this.session.mcp().then((state) => this.mcp(state)))
    // So for a hook or a language server it did not run: asked about at once, or said how to approve.
    if (event.type === "diagnostic" && event.kind === "hooks" && this.session.hooks !== undefined) this.track(this.session.hooks().then((state) => this.hooks(state)))
    if (event.type === "diagnostic" && event.kind === "lsp" && this.session.lsp !== undefined) this.track(this.session.lsp().then((state) => this.lsp(state)))
    if (event.type === "tool.settled" && event.data.outcome === "success") {
      const wake = (event.data.display as { wake?: { action?: unknown; id?: unknown } } | null)?.wake
      if (wake?.action === "create" && typeof wake.id === "string") this.track(this.created(wake.id))
    }
  }

  /** At the end of a run with nobody to ask: what became of the servers, said once. */
  async finish(): Promise<void> {
    if (!this.options.attended && this.session.mcp !== undefined) await this.track(this.session.mcp().then((state) => this.mcp(state)))
    if (!this.options.attended && this.session.hooks !== undefined) await this.track(this.session.hooks().then((state) => this.hooks(state)))
    if (!this.options.attended && this.session.lsp !== undefined) await this.track(this.session.lsp().then((state) => this.lsp(state)))
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
        if (this.options.attended && this.io.ask !== null) this.track(askMcpServer(server, this.session, this.io))
        else this.io.out.notice(mcpUnattendedText(server), "warn")
      }
    }
  }

  /** The project's hooks that wait: each is a question at the prompt, one after another; with nobody to ask, how to approve them, once. */
  private hooks(state: HooksStateResult): void {
    const fresh = state.hooks.filter((hook) => hook.state === "awaiting_approval" && hook.question !== null && !this.asked.has(`hook:${hook.fingerprint}`))
    if (fresh.length === 0) return
    for (const hook of fresh) this.asked.add(`hook:${hook.fingerprint}`)
    if (!this.options.attended || this.io.ask === null) return this.io.out.notice(hooksUnattendedText(fresh), "warn")
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
    if (!this.options.attended || this.io.ask === null) return this.io.out.notice(lspUnattendedText(fresh), "warn")
    this.track(
      (async () => {
        for (const server of fresh) await askLspServer(server, this.session, this.io)
      })(),
    )
  }

  private async created(id: string): Promise<void> {
    if (this.session.wakeSecret === undefined) return
    const secret = await this.session.wakeSecret(id)
    // Not a webhook: there is nothing to show.
    if (secret.secret === null) return
    if (this.options.secrets) return this.io.out.lines(webhookSecretLines(secret, true))
    this.io.out.notice(`webhook wake-up ${id} is at POST ${secret.url}; its secret is not printed because this output is not a terminal. Open the session (\`--session ${this.session.id}\`) and type /wakeups secret ${id} to see it.`)
  }
}
