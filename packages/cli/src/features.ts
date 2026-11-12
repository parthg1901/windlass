/**
 * What `/mcp`, `/skills`, `/wakeups` and `/memory` say, and the MCP server
 * question, as lines with a tone: one judgement of what is worth saying,
 * shared by the line CLI and the TUI (which maps tones onto its theme). Every
 * line is a sentence a first-time user can act on: what is so, and what to do
 * next. Nothing here is ever cut: long paths and reasons wrap where they are shown.
 */
import { brand } from "@windlass/core"
import { isUndone, turnsOf } from "@windlass/acp/turns"
import { type McpServerInfo, type McpStateResult, type MemoryStateResult, type SkillsResult, type WakeCreateParams, type WakeCreateResult, type WakeListResult, type WakeRun, type WakeSecretResult, type WatchesResult, quotedCommand } from "@windlass/acp/extensions"

export type LineTone = "plain" | "dim" | "warn" | "error" | "ok" | "bold" | "accent"

export interface Line {
  readonly text: string
  readonly tone: LineTone
  /** Columns of indentation, kept when the line wraps. */
  readonly indent?: number
  /**
   * A command, word for word: shown whole, broken where the row ends and
   * never reflowed at its spaces or cut, so that its end is as visible as
   * its start.
   */
  readonly verbatim?: boolean
  /**
   * A path and nothing else: shown whole, never cut and never broken by the
   * interface, so that it can be read to its end and copied in one piece.
   */
  readonly path?: boolean
  /**
   * The column, counted from the line's own indentation, where its second
   * part starts (a description after a padded label): rows that continue it
   * start there too, so a wrapped description stays in its column.
   */
  readonly hang?: number
}

/** A command the user is asked about, as a line of its own: whole and word for word. */
export const commandLine = (text: string, indent = 4): Line => ({ text, tone: "plain", indent, verbatim: true })

/** A server's command as it is shown: each argument quoted where it needs it, so its boundaries are unambiguous. */
export function shownCommand(argv: readonly string[] | null | undefined, joined: string): string {
  return argv == null ? joined : quotedCommand(argv)
}

const line = (text: string, tone: LineTone = "plain", indent = 0): Line => ({ text, tone, indent })

/** A path as a line of its own: whole, never cut or broken where it is shown. */
export const pathLine = (path: string, tone: LineTone = "dim", indent = 0): Line => ({ text: path, tone, indent, path: true })

/** Where something is defined: a few words, then the file on a line of its own. */
export function definedInLines(origin: "user" | "project" | null, file: string | null, indent: number): Line[] {
  if (file === null) return [line("defined in a configuration file", "dim", indent)]
  return [line(origin === "project" ? "defined in this project's file:" : origin === "user" ? "defined in your file:" : "defined in:", "dim", indent), pathLine(file, "dim", indent + 2)]
}

const USER_FILE = `~/.config/${brand.directory}/config.json`
const PROJECT_FILE = `.${brand.directory}/config.json`

// ---------------------------------------------------------------- MCP

/** A server's state in a few words. */
export function mcpStateWords(server: McpServerInfo): string {
  switch (server.state) {
    case "running":
      return `running · ${server.tools === 1 ? "1 tool" : `${server.tools ?? 0} tools`}${server.hiddenTools > 0 ? ` (${server.hiddenTools} hidden by its allow/deny list)` : ""}`
    case "starting":
      return "starting…"
    case "failed":
      return `failed to start${server.retryInMs === null ? "" : ` · retried in ${Math.max(1, Math.round(server.retryInMs / 1000))} s`}`
    case "awaiting_approval":
      return "waiting for your approval: not started"
    case "disabled":
      return "disabled (enabled: false in its definition)"
    case "stopped":
      return "stopped"
    case "not_started":
      // Until a session's first message is sent, the engine has not looked at the servers: a project's may still need an approval.
      return server.origin === "project" ? "not looked at yet: a project's server is asked about once the first message is sent" : "not started yet: servers start with the next message"
  }
}

/**
 * `/mcp approve <name>` for a server that does not wait for an approval:
 * the state it is in, and for one a session has not looked at yet (servers
 * are read when the first message is sent) what to do instead.
 */
export function mcpNotWaitingText(server: McpServerInfo): string {
  if (server.state === "not_started" && server.origin === "project")
    return `The MCP server "${server.name}" cannot be approved yet: a session looks at its MCP servers when its first message is sent. Send your message: if this project's server still needs your approval you are asked then (/mcp approve ${server.name} asks again), and the agent has its tools from the message after you approve.`
  if (server.state === "not_started") return `The MCP server "${server.name}" is your own and needs no approval: it starts with your next message.`
  return `the MCP server "${server.name}" does not wait for an approval: it is ${server.state.replace(/_/g, " ")}`
}

/**
 * What approving a project's server comes to, said plainly. `midTurn`: a
 * turn is running; it began without the server, and the agent may already
 * have been told there are no such tools.
 */
export function mcpApprovedText(server: Pick<McpServerInfo, "name">, midTurn: boolean): string {
  return midTurn
    ? `approved: "${server.name}" starts now. The turn in progress began without it, so the agent may already have said it has no such tools: ask again in your next message, when it has them. /mcp shows it.`
    : `approved: "${server.name}" starts now; the agent has its tools from your next message. /mcp shows it.`
}

/**
 * Before a session's first message: the project's servers the engine has
 * not looked at yet, said once so that the question that may follow, in the
 * middle of the first turn, is expected. `null` when there are none.
 */
export function mcpFirstMessageText(servers: readonly McpServerInfo[]): string | null {
  const waiting = servers.filter((server) => server.state === "not_started" && server.origin === "project")
  if (waiting.length === 0) return null
  const names = waiting.map((server) => `"${server.name}"`).join(", ")
  const one = waiting.length === 1
  return `This project's configuration names ${one ? `the MCP server ${names}` : `MCP servers (${names})`}. A project's server starts only once you have approved it: if ${one ? "it has" : "they have"} not been approved, you are asked while this first turn runs, and the agent has ${one ? "its" : "their"} tools from the message after you approve.`
}

/** `/mcp`: every server with its state, its tools, what it runs and where it is defined. */
export function mcpLines(state: McpStateResult): Line[] {
  if (!state.available) return [line(`This engine offers no MCP servers.`, "dim")]
  if (state.servers.length === 0)
    return [
      line("No MCP server is configured for this session.", "dim"),
      line(`Name one under "mcp": { "servers": { ... } } in your file (${USER_FILE}) or the project's (${PROJECT_FILE}); docs/mcp.md has an example.`, "dim", 2),
    ]
  const lines: Line[] = [line(`MCP servers (${state.servers.length}):`, "bold")]
  for (const server of state.servers) {
    const tone: LineTone = server.state === "running" ? "ok" : server.state === "failed" || server.state === "awaiting_approval" ? "warn" : "dim"
    lines.push(line(`${server.name} · ${mcpStateWords(server)}`, tone, 2))
    if (server.target !== null) lines.push(line(`${server.transport === "http" ? "reached at" : "runs"} ${shownCommand(server.argv, server.target)}`, "dim", 4))
    lines.push(...definedInLines(server.origin, server.file, 4))
    if (server.error !== null) lines.push(line(`why: ${server.error}`, "warn", 4))
    if (server.state === "awaiting_approval") lines.push(line(`/mcp approve ${server.name} starts it for this project (you are asked first).`, "dim", 4))
  }
  return lines
}

/** The question about a server the project's configuration names, in the engine's own words, with what each answer does. */
export function mcpQuestionLines(server: McpServerInfo): Line[] {
  const question = server.question
  return [
    line(`? Start the MCP server "${server.name}" that this project's configuration names?`, "bold"),
    commandLine(shownCommand(server.argv, question?.subject ?? server.target ?? "")),
    ...(server.file === null ? [] : definedInLines(null, server.file, 2)),
    ...(question?.details ?? []).map((detail) => line(detail, "dim", 2)),
    line("y  start it for this project and remember that (30 days, this exact definition: an edited one is asked about again)", "dim", 2),
    line(`n  not now: it stays stopped and the agent is told it waits for you; /mcp approve ${server.name} asks again`, "dim", 2),
  ]
}

/** A server that failed to start, for the user: why, and what happens next. */
export function mcpFailureText(server: McpServerInfo): string {
  const retry = server.retryInMs === null ? "" : ` It is tried again in ${Math.max(1, Math.round(server.retryInMs / 1000))} s;`
  return `MCP server "${server.name}" could not start: ${server.error ?? "no reason was given"}.${retry} /mcp shows its state, and ${server.file ?? "its configuration file"} defines it.`
}

/**
 * In a run with nobody to ask: how many of the project's hooks, language servers and MCP servers were not run
 * because nobody approved them, and the one way to approve them. One sentence for all of them.
 */
export function unapprovedText(waiting: { readonly hooks: number; readonly lsp: number; readonly mcp: number }): string {
  const count = (n: number, one: string) => (n === 0 ? null : `${n} ${one}${n === 1 ? "" : "s"}`)
  const parts = [count(waiting.hooks, "hook"), count(waiting.lsp, "language server"), count(waiting.mcp, "MCP server")].filter((part) => part !== null)
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
  const one = waiting.hooks + waiting.lsp + waiting.mcp === 1
  return `not run: ${list} that this project's configuration names and you have not approved. To approve ${one ? "it" : "them"}, run \`${brand.binary}\` in this directory and answer the ${one ? "question" : "questions"} it asks; the approval is remembered for this project.`
}

// ---------------------------------------------------------------- skills

const SCOPE_WORDS = { project: "this project", config: "skills.paths", user: "your own skills" } as const

/** `/skills`: each skill with its description and where it comes from, then the shadowed and broken ones with their full paths. */
export function skillsLines(result: SkillsResult): Line[] {
  if (!result.available) return [line("This engine offers no skills.", "dim")]
  const lines: Line[] = []
  if (result.skills.length === 0) {
    lines.push(line("No skill was found for this directory.", "dim"))
    lines.push(line(`A skill is a directory with a SKILL.md (front matter name and description, then the instructions) under ${PROJECT_FILE.replace("config.json", "skills/")}, .agents/skills/ or .claude/skills/ here or in a parent up to the repository root, or in ~/.config/${brand.directory}/skills/; docs/skills.md has an example.`, "dim", 2))
  } else {
    lines.push(line(`Skills the model can load (${result.skills.length}):`, "bold"))
    for (const skill of result.skills) {
      lines.push(line(`${skill.name} · ${skill.description}`, "plain", 2))
      lines.push(line(`from ${SCOPE_WORDS[skill.scope]}:`, "dim", 4), pathLine(skill.path, "dim", 6))
    }
  }
  const shadowed = result.problems.filter((problem) => problem.severity === "shadowed")
  const broken = result.problems.filter((problem) => problem.severity !== "shadowed")
  if (shadowed.length > 0) {
    lines.push(line(`Hidden by a skill of the same name (${shadowed.length}):`, "bold"))
    for (const problem of shadowed) {
      lines.push(pathLine(problem.path, "dim", 2))
      lines.push(line(problem.reason, "dim", 4))
    }
  }
  if (broken.length > 0) {
    lines.push(line(`Not loaded (${broken.length}): fix the file and the next message picks it up`, "warn"))
    for (const problem of broken) {
      lines.push(pathLine(problem.path, "warn", 2))
      lines.push(line(`${problem.severity === "warning" ? "loaded, but: " : ""}${problem.reason}`, "dim", 4))
    }
  }
  return lines
}

// ---------------------------------------------------------------- wake-ups

/**
 * A moment as the user's clock has it, with the zone: `2026-11-12 15:00
 * GMT+5:30` (seconds only when it has any). `timeZone` is the machine's
 * unless given.
 */
export function localTime(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { ...(timeZone === undefined ? {} : { timeZone }), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(at)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}${part("second") === "00" ? "" : `:${part("second")}`} ${part("timeZoneName")}`
}

/** `text` with every UTC timestamp the engine wrote (`2026-11-12T09:30:00Z`) as the user's local time with the zone. */
export function localTimes(text: string, timeZone?: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, (stamp) => {
    const at = new Date(stamp)
    return Number.isNaN(at.getTime()) ? stamp : localTime(at, timeZone)
  })
}

/** `/wakeups`: the session's wake-ups, pending first, in the engine's words; a webhook's URL, never its secret. */
export function wakeLines(result: WakeListResult, timeZone?: string): Line[] {
  if (!result.available) return [line("This engine has no wake-ups.", "dim")]
  if (result.wakeups.length === 0)
    return [line("This session has no wake-up. Ask the agent for one (\"tell me when CI is green\", \"remind me in an hour\"), or set one yourself: /wakeups add in 1h look at the build again (/wakeups add shows every form).", "dim")]
  const pending = result.wakeups.filter((wake) => wake.state === "pending")
  const ended = result.wakeups.filter((wake) => wake.state !== "pending")
  const lines: Line[] = [line(`Wake-ups of this session: ${pending.length} pending${ended.length === 0 ? "" : `, ${ended.length} ended`}`, "bold")]
  if (!result.running && pending.length > 0)
    lines.push(line("Nothing in this process fires them (see docs/wake-ups.md, \"Where wake-ups fire today\"): one that comes due fires, late, in the first process that runs the scheduler.", "warn", 2))
  for (const wake of [...pending, ...ended]) {
    // The engine writes its times in UTC: here they are the user's clock, with the zone.
    lines.push(line(`${wake.id} · ${localTimes(wake.description, timeZone)}`, wake.state === "pending" ? "plain" : "dim", 2))
    for (const text of wake.lines) lines.push(line(localTimes(text, timeZone), "dim", 4))
  }
  if (pending.length > 0) lines.push(line(`/wakeups cancel <id> stops one${pending.some((wake) => wake.trigger === "webhook") ? "; /wakeups secret <id> shows a webhook's secret" : ""}; /wakeups add sets one up.`, "dim", 2))
  return lines
}

/** How `/wakeups add` is used: one line per kind of wake-up. */
export const WAKE_ADD_USAGE: readonly string[] = [
  "/wakeups add in <duration> <message>               once, after a delay: /wakeups add in 20m look at the deploy again",
  "/wakeups add at <time> <message>                   once, at a time: 17:30 (today, or tomorrow when it has passed) or 2026-11-13T09:00",
  "/wakeups add every <duration> <message>            again and again: /wakeups add every 1h check the queue",
  '/wakeups add check <duration> "<command>" <message>  runs the command every <duration> and fires once it exits 0 (you are asked how it may run)',
  "/wakeups add webhook <message>                     fires when a signed HTTP request arrives; its address and secret are shown once",
  "A duration is a number and a unit, such as 90s, 20m, 2h or 1d (or several: 1h30m). The message is what the agent is told when it fires.",
]

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** `90s`, `20m`, `2h`, `1d`, `1h30m` in milliseconds; `null` for anything else. */
export function durationMs(text: string): number | null {
  if (!/^(\d+[smhd])+$/i.test(text)) return null
  let total = 0
  for (const part of text.toLowerCase().matchAll(/(\d+)([smhd])/g)) total += Number(part[1]) * UNIT_MS[part[2] as keyof typeof UNIT_MS]
  return total > 0 ? total : null
}

/**
 * `17:30` (the next time the clock shows it: today, or tomorrow when it
 * has passed) or a date and time as the user's clock has them
 * (`2026-11-13T09:00`), in milliseconds since the epoch; `null` for
 * anything else.
 */
export function clockTime(text: string, now: number): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (clock !== null) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])]
    if (hours > 23 || minutes > 59) return null
    const at = new Date(now)
    at.setHours(hours, minutes, 0, 0)
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(text)) return null
  const at = new Date(text).getTime()
  return Number.isNaN(at) ? null : at
}

/** What was typed after `/wakeups add`: the wake-up to ask the engine for, and for a check its command (the user is asked how it may run). */
export type WakeAddEntry = { readonly request: Omit<WakeCreateParams, "sessionId" | "run">; readonly check: { readonly command: string; readonly every: string } | null } | { readonly problem: string }

/**
 * `in <duration> <message>`, `at <time> <message>`, `every <duration>
 * <message>`, `check <duration> "<command>" <message>` or `webhook
 * <message>`. The message is everything after, as typed. A check's command
 * is in double or single quotes (one word needs none), so that where it
 * ends is not a guess.
 */
export function wakeAddEntry(rest: string, now: number): WakeAddEntry {
  const typed = rest.trim()
  const [kind = "", ...others] = typed.split(/\s+/)
  const after = (words: number) => {
    let left = typed
    for (let index = 0; index < words; index += 1) left = left.replace(/^\S+\s*/, "")
    return left
  }
  // What is missing, then the form of that kind of wake-up with what it does.
  const usage = (what: string): WakeAddEntry => ({ problem: `${what} ${WAKE_ADD_USAGE.find((line) => line.startsWith(`/wakeups add ${kind} `))?.replace(/\s{2,}/, ": ") ?? ""}`.trimEnd() })
  if (kind === "webhook") {
    const message = after(1)
    return message === "" ? usage("/wakeups add webhook needs the message the agent is told when a request arrives.") : { request: { message, trigger: { kind: "webhook" } }, check: null }
  }
  if (kind === "in" || kind === "every" || kind === "check") {
    const duration = durationMs(others[0] ?? "")
    if (duration === null) return usage(`/wakeups add ${kind} needs a duration first, such as 90s, 20m, 2h or 1d${others[0] === undefined ? "" : ` ("${others[0]}" is not one)`}.`)
    if (kind !== "check") {
      const message = after(2)
      if (message === "") return usage(`/wakeups add ${kind} ${others[0]} needs the message the agent is told when it fires.`)
      return { request: { message, trigger: kind === "in" ? { kind: "after", delayMs: duration } : { kind: "every", intervalMs: duration } }, check: null }
    }
    const left = after(2)
    const quoted = /^(["'])([\s\S]*?)\1(?=\s|$)\s*([\s\S]*)$/.exec(left)
    const bare = quoted === null && !/^["']/.test(left) ? /^(\S+)\s*([\s\S]*)$/.exec(left) : null
    const command = quoted?.[2] ?? bare?.[1] ?? ""
    const message = quoted?.[3] ?? bare?.[2] ?? ""
    if (/^["']/.test(left) && quoted === null) return { problem: "The command's quote is not closed: put the whole command between two double quotes (or two single quotes), then the message." }
    if (command.trim() === "") return usage("/wakeups add check needs the command to run, in quotes.")
    if (message === "") return usage("/wakeups add check needs the message the agent is told once the command exits 0, after the command.")
    return { request: { message, trigger: { kind: "check", command, intervalMs: duration, fire: "until" } }, check: { command, every: others[0]! } }
  }
  if (kind === "at") {
    const at = clockTime(others[0] ?? "", now)
    if (at === null) return usage(`/wakeups add at needs a time first: 17:30, or a date and time such as 2026-11-13T09:00${others[0] === undefined ? "" : ` ("${others[0]}" is neither)`}.`)
    const message = after(2)
    if (message === "") return usage(`/wakeups add at ${others[0]} needs the message the agent is told then.`)
    return { request: { message, trigger: { kind: "at", at } }, check: null }
  }
  return { problem: `/wakeups add ${kind}: there is no such kind of wake-up. It takes in, at, every, check or webhook; /wakeups add with nothing after it shows each.` }
}

/** `/wakeups add` with nothing after it: every form, with what it sets up. */
export function wakeAddUsageLines(): Line[] {
  return [line("Set a wake-up of your own: the agent is told the message when it fires, as a new turn.", "bold"), ...WAKE_ADD_USAGE.map((text) => line(text, "dim", 2))]
}

/** The question about a check's command, with what each answer lets the command do: asked like any command the agent would run. */
export function wakeCheckQuestionLines(check: { readonly command: string; readonly every: string }): Line[] {
  return [
    line(`? Run this command every ${check.every} until it exits 0?`, "bold"),
    commandLine(check.command),
    line("It runs in this session's directory, without the agent, each time the wake-up checks; when it exits 0 the agent is told and the wake-up is done.", "dim", 2),
    line("s  run it in the sandbox, without network", "dim", 2),
    line("w  run it in the sandbox, with network", "dim", 2),
    line("u  run it outside the sandbox, with your permissions", "dim", 2),
    line("N  do not set the wake-up up", "dim", 2),
  ]
}

/** The answers to that question, as the prompt shows them. */
export const WAKE_CHECK_ANSWERS = "[s] sandbox · [w] sandbox with network · [u] no sandbox · [N] cancel › "

/** The access an answer to the check question gives the command; `null`: the wake-up is not set up. */
export function wakeCheckAccess(answer: string | null): WakeRun | null {
  const word = (answer ?? "").trim().toLowerCase()
  if (word === "s" || word === "sandbox" || word === "y" || word === "yes") return { kind: "sandboxed", network: false, writableRoots: [] }
  if (word === "w" || word === "network") return { kind: "sandboxed", network: true, writableRoots: [] }
  if (word === "u" || word === "unsandboxed") return { kind: "unsandboxed" }
  return null
}

/** A wake-up the user created: what it is, in the engine's words, and how to cancel it. */
export function wakeCreatedLines(result: WakeCreateResult, timeZone?: string): Line[] {
  const wake = result.wake
  if (!result.created || wake === null) return [line(result.message, "warn")]
  return [
    line(`Wake-up ${wake.id} set: ${localTimes(wake.description, timeZone)}`, "bold"),
    ...wake.lines.map((text) => line(localTimes(text, timeZone), "dim", 2)),
    line(`/wakeups lists it; /wakeups cancel ${wake.id} stops it.`, "dim", 2),
  ]
}

/**
 * A wake-up was created in a run that fires none (a one-prompt run exits
 * when its turn ends): said at once, with where it will fire, so that "I
 * will remind you in a minute" is not taken for something this run does.
 */
export function wakeNotFiringText(wake: { readonly id: string; readonly description: string | null }, sessionId: string): string {
  const what = wake.description === null ? `Wake-up ${wake.id}` : `Wake-up ${wake.id} (${localTimes(wake.description)})`
  return `${what} was created, but this run does not fire wake-ups: it ends with its turn. It fires, late if its time has passed by then, the next time ${brand.name} runs interactively on this machine (\`${brand.binary}\` with no prompt, \`${brand.binary} tui\`, or an editor). \`${brand.binary} --session ${sessionId}\` opens this session: /wakeups lists it there, and /wakeups cancel ${wake.id} removes it.`
}

/** A webhook wake-up's address and secret, for the user. */
export function webhookSecretLines(secret: WakeSecretResult, created: boolean): Line[] {
  if (secret.secret === null || secret.url === null) return [line(secret.message ?? `${secret.id} has no secret`, "warn")]
  return [
    line(`${created ? "Webhook wake-up created" : "Webhook wake-up"} ${secret.id}: sign each request with its secret (docs/wake-ups.md shows how).`, "bold"),
    line(`URL     POST ${secret.url}`, "plain", 2),
    line(`secret  ${secret.secret}`, "plain", 2),
    line(`The model never sees the secret. ${created ? `/wakeups secret ${secret.id} shows it again.` : "Keep it out of logs and commits."}`, "dim", 2),
  ]
}

/** What a message delivered by a wake-up says, for the transcript: which wake-up, why, and the message it was set up with. */
export function wakeMessageSummary(text: string, origin: string): { readonly head: string; readonly message: string | null } {
  const first = text.split("\n", 1)[0] ?? ""
  const match = /^\[(Wake-up|Webhook) (\S+)(?: stopped)? · ([^\]]*)\]$/.exec(first)
  const id = match?.[2] ?? null
  const stopped = / stopped · /.test(first)
  const marker = text.indexOf("The message set up with the wake-up:\n")
  const notice = text.indexOf("Its message was:\n")
  const body = marker >= 0 ? text.slice(marker + "The message set up with the wake-up:\n".length) : notice >= 0 ? text.slice(notice + "Its message was:\n".length) : null
  const message = body === null ? null : (body.split("\n\n", 1)[0] ?? "").trim() || null
  const why = origin === "wake_webhook" ? "a webhook request arrived" : stopped ? "it stopped" : "it fired"
  return { head: `wake-up${id === null ? "" : ` ${id}`}: ${why}${match?.[3] === undefined ? "" : ` (${localTimes(match[3])})`} · not typed by you`, message }
}

// ---------------------------------------------------------------- watches on a background command's output

/** What a watch looks for, in the engine's words: `text "ready"`, `pattern /error/i`. */
export function watchWords(watch: { readonly pattern: string; readonly regex: boolean; readonly ignoreCase: boolean }): string {
  if (watch.regex) return `pattern /${watch.pattern}/${watch.ignoreCase ? "i" : ""}`
  return `text ${JSON.stringify(watch.pattern)}${watch.ignoreCase ? ", ignoring case" : ""}`
}

/** How often a watch may fire, in words. */
export const watchTimes = (limit: number): string => (limit === 1 ? "once" : `up to ${limit} times`)

/** How `/watch` is used, in one sentence. */
export const WATCH_USAGE =
  "/watch <command id> <text> tells the agent when that background command prints a line with the text (once; put --times <n>, --regex or --ignore-case before the text for more often, a regular expression, or any case); /watch lists the running commands and their watches; /watch remove <watch id> removes one"

/** What was typed after `/watch`. */
export type WatchEntry =
  | { readonly kind: "list" }
  | { readonly kind: "remove"; readonly watchId: string }
  | { readonly kind: "set"; readonly command: string; readonly pattern: string; readonly regex: boolean; readonly ignoreCase: boolean; readonly limit: number | null }
  | { readonly problem: string }

/**
 * `/watch`, `/watch list`, `/watch remove <watch id>`, or `/watch <command
 * id> [--regex] [--ignore-case] [--times <n>] <text>`. The text is
 * everything after the options, as typed, spaces included; `--` ends the
 * options for a text that starts with two dashes.
 */
export function watchEntry(rest: string): WatchEntry {
  const typed = rest.trim()
  if (typed === "" || typed === "list") return { kind: "list" }
  const [first = "", ...others] = typed.split(/\s+/)
  if (first === "remove" || first === "rm") return others.length === 1 ? { kind: "remove", watchId: others[0]! } : { problem: "/watch remove takes one watch's ID, as /watch lists them: /watch remove bg_1.w1" }
  let left = typed.slice(first.length).trimStart()
  let regex = false
  let ignoreCase = false
  let limit: number | null = null
  for (;;) {
    const option = /^(--regex|--ignore-case|--times|--)(?=\s|$)\s*/.exec(left)
    if (option === null) break
    left = left.slice(option[0].length)
    if (option[1] === "--") break
    if (option[1] === "--regex") regex = true
    else if (option[1] === "--ignore-case") ignoreCase = true
    else {
      const count = /^(\d+)(?=\s|$)\s*/.exec(left)
      if (count === null) return { problem: "/watch --times takes a number: how often the watch may fire, such as --times 3" }
      limit = Number(count[1])
      left = left.slice(count[0].length)
    }
  }
  if (left === "") return { problem: `/watch ${first} needs the text to look for. ${WATCH_USAGE}` }
  return { kind: "set", command: first, pattern: left, regex, ignoreCase, limit }
}

/** `/watch`: the background commands that are running, each with the watches on its output, and how to set and remove one. */
export function watchLines(result: WatchesResult): Line[] {
  if (result.commands.length === 0)
    return [
      line("No background command is running, so there is no output to watch.", "dim"),
      line("A watch tells the agent when a command it started in the background (a server, a file watcher) prints a line you name; /watch <command id> <text> sets one while the command runs.", "dim", 2),
    ]
  const lines: Line[] = [line(`Background commands running (${result.commands.length}):`, "bold")]
  for (const command of result.commands) {
    lines.push(line(`${command.spawnId} · ${command.command}`, "plain", 2))
    if (command.watches.length === 0) lines.push(line("no watch on its output", "dim", 4))
    for (const watch of command.watches)
      lines.push(line(`${watch.watchId} · ${watch.description} · fired ${watch.fired} of ${watch.limit}${watch.watching ? "" : watch.fired >= watch.limit ? " · done" : " · removed"}`, watch.watching ? "plain" : "dim", 4))
  }
  lines.push(line(WATCH_USAGE, "dim"))
  return lines
}

/** A watch that was set (`watch.started`), for the transcript. */
export function watchStartedText(watch: { readonly watchId: string; readonly spawnId: string; readonly pattern: string; readonly regex: boolean; readonly ignoreCase: boolean; readonly limit: number }): { readonly head: string; readonly tail: string } {
  return { head: `watching background ${watch.spawnId} for ${watchWords(watch)}`, tail: ` · the agent is told when it prints a matching line (${watchTimes(watch.limit)}) · ${watch.watchId}` }
}

/** A watch that fired (`watch.fired`), for the transcript: which watch, on which command, and that the message is the watch's, not the user's. */
export function watchFiredText(fired: { readonly watchId: string; readonly spawnId: string; readonly firing: number }, limit: number | null): string {
  return `watch ${fired.watchId}: background ${fired.spawnId} printed a matching line${limit === null ? "" : ` (${fired.firing} of ${limit})`} · the agent is told · sent by the watch, not typed by you`
}

/** A watch that ended before it had fired as often as it may (`watch.ended`), for the transcript. */
export function watchEndedText(ended: { readonly watchId: string; readonly spawnId: string; readonly reason: "removed" | "command_ended" | "lost" | "too_slow" }): string {
  const why =
    ended.reason === "removed"
      ? "removed"
      : ended.reason === "command_ended"
        ? `ended with its command (background ${ended.spawnId})`
        : ended.reason === "too_slow"
          ? "ended: its pattern took too long to match a line"
          : `lost: background ${ended.spawnId} did not survive a restart`
  return `watch ${ended.watchId} ${why}`
}

// ---------------------------------------------------------------- memory

/** `/memory`: the notes in force, what waits for your confirmation, files with mistakes, and the review report. */
export function memoryLines(state: MemoryStateResult): Line[] {
  if (!state.enabled) return [line(state.off ?? "Memory is off in this session.", "dim")]
  const lines: Line[] = []
  const active = state.notes.filter((note) => note.state === "active")
  const lapsed = state.notes.filter((note) => note.state !== "active")
  if (active.length === 0) lines.push(line("No note is in force. /remember <text> saves one; the agent saves notes when you say something worth keeping.", "dim"))
  else {
    lines.push(line(`Notes in force (${active.length}), given to later sessions:`, "bold"))
    for (const note of active) {
      lines.push(line(`[${note.id}] ${note.scope === "user" ? "about you" : "this project"} · ${note.kind}: ${note.text}`, "plain", 2))
      lines.push(line(`${note.author === "user" ? "written by you" : note.quote === null ? "saved by the agent" : `saved by the agent from your words "${note.quote}"`}, ${note.created.slice(0, 10)} · lapses ${note.expires === "never" ? "never" : `${note.expires} after it was last confirmed`}`, "dim", 4))
    }
  }
  if (lapsed.length > 0) {
    lines.push(line(`Not in force (${lapsed.length}):`, "bold"))
    for (const note of lapsed) lines.push(line(`[${note.id}] ${note.state}: ${note.text}`, "dim", 2))
  }
  if (state.pending.length > 0) {
    lines.push(line(`Waiting for your confirmation (${state.pending.length}): not used until you confirm`, "warn"))
    lines.push(line(state.pending[0]!.why, "dim", 2))
    for (const note of state.pending) {
      lines.push(line(`[${note.id}] ${note.scope} ${note.kind}: ${note.text}`, "plain", 2))
      lines.push(line(`/memory confirm ${note.id} · /memory reject ${note.id}`, "dim", 4))
    }
  }
  if (state.problems.length > 0) {
    lines.push(line(`Files that are not valid and are not used (${state.problems.length}): fix or delete them`, "warn"))
    for (const problem of state.problems) lines.push(line(problem.message, "dim", 2))
  }
  const review = state.review.filter((item) => item.reason !== "invalid-file" && item.reason !== "pending-confirmation")
  if (review.length > 0) {
    lines.push(line("To look at:", "bold"))
    for (const item of review) lines.push(line(`${item.id === null ? "" : `[${item.id}] `}${item.detail}`, "dim", 2))
  }
  if (state.paths !== null) lines.push(line(`The notes are files you can edit: ${state.paths.project ?? "(no project)"} and ${state.paths.user}.`, "dim"))
  lines.push(line("/remember [--me] <text> saves a note · /forget <id> retracts one · /memory renew <id> keeps one from lapsing", "dim"))
  return lines
}

/** `/remember [--me|--user] <text>`: the note and its scope. */
export function rememberArgs(rest: string): { readonly text: string; readonly scope: "user" | "project" } {
  const match = /^--(me|user)\s+([\s\S]*)$/.exec(rest.trim())
  return match === null ? { text: rest.trim(), scope: "project" } : { text: match[2]!.trim(), scope: "user" }
}

/** `/memory <action> <id>`: what to do, or `null` for the listing. */
export function memoryAction(rest: string): { readonly action: "confirm" | "reject" | "renew" | "retract"; readonly id: string } | { readonly problem: string } | null {
  const words = rest.trim().split(/\s+/).filter((word) => word !== "")
  if (words.length === 0) return null
  const action = ({ confirm: "confirm", reject: "reject", renew: "renew", forget: "retract", retract: "retract" } as const)[words[0]!.toLowerCase() as "confirm"]
  if (action === undefined || words.length !== 2) return { problem: "/memory takes nothing (the listing), or confirm, reject, renew or forget and a note's ID: /memory confirm m_1a2b3c4d" }
  return { action, id: words[1]! }
}

// ---------------------------------------------------------------- a resumed session

/**
 * The end of a resumed session, compactly, so the user knows where they are:
 * the last `count` turns, each its prompt, the agent's last words and how it
 * ended. From the stored log; `[]` for a session without a turn.
 */
export function recapLines(events: readonly { readonly seq: number; readonly type: string; readonly data?: unknown }[], count = 2): Line[] {
  const turns = turnsOf(events).filter((turn) => !isUndone(turn)).slice(-count)
  if (turns.length === 0) return []
  const clip = (text: string, max: number) => {
    const flat = text.replace(/\s+/g, " ").trim()
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
  }
  const lines: Line[] = [line(turns.length === 1 ? "Where you left off:" : `Where you left off (the last ${turns.length} turns):`, "dim")]
  for (const turn of turns) {
    const end = turn.endSeq ?? Number.POSITIVE_INFINITY
    const inside = events.filter((item) => item.seq >= turn.messageSeq && item.seq <= end)
    const said = inside.findLast((item) => item.type === "text.ended")
    const ending = turn.endSeq === null ? null : events.find((item) => item.seq === turn.endSeq)
    const data = (ending?.data ?? {}) as { verification?: { status?: string }; message?: string; reason?: string }
    const how =
      ending === undefined || ending === null
        ? "not finished: it resumes with your next message"
        : ending.type === "execution.succeeded" || ending.type === "turn.ended"
          ? data.verification?.status === "unresolved"
            ? "stopped with failing checks"
            : "done"
          : ending.type === "execution.failed"
            ? `failed: ${clip(data.message ?? "", 100)}`
            : ending.type === "execution.interrupted"
              ? data.reason === "shutdown"
                ? "stopped for a shutdown: it resumes with your next message"
                : "interrupted"
              : "ended"
    lines.push(line(`› ${clip(turn.prompt === "" ? "(started without a message)" : turn.prompt, 100)}`, "plain", 2))
    if (said !== undefined) lines.push(line(clip(String((said.data as { text?: unknown }).text ?? ""), 220), "dim", 4))
    lines.push(line(`turn ${turn.number}: ${how}`, how === "done" ? "dim" : "warn", 4))
  }
  return lines
}

// ---------------------------------------------------------------- copies of the workspace

/** What a copy of the workspace (a `--copy` fork, a replay under `execute`) holds and lacks, and what follows from it. */
export const COPY_NOTE =
  "The copy holds the workspace's tracked and small untracked files; it has no ignored files (such as node_modules or build output), no large untracked files and no .git, so it is not a git repository. Commands that need installed dependencies, git or the project's checks fail there until the dependencies are installed in the copy (for example with the project's install command)."
