/**
 * What `/mcp`, `/skills`, `/wakeups` and `/memory` say, and the MCP server
 * question, as lines with a tone: one judgement of what is worth saying,
 * shared by the line CLI and the TUI (which maps tones onto its theme). Every
 * line is a sentence a first-time user can act on: what is so, and what to do
 * next. Nothing here is ever cut: long paths and reasons wrap where they are shown.
 */
import { brand } from "@windlass/core"
import { isUndone, turnsOf } from "@windlass/acp/turns"
import { type McpServerInfo, type McpStateResult, type MemoryStateResult, type SkillsResult, type WakeListResult, type WakeSecretResult, quotedCommand } from "@windlass/acp/extensions"

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

/** In a run with nobody to ask: why a project's server did not start, and how to start it. */
export function mcpUnattendedText(server: McpServerInfo): string {
  return `MCP server "${server.name}" was not started: this project's configuration names it, and a project's server runs only after you approve it, which needs someone at the terminal. To approve it, run \`${brand.binary}\` in this directory and answer the question it asks (or type /mcp approve ${server.name}); the approval is remembered for this project.`
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
    return [line("This session has no wake-up. Ask the agent for one (\"tell me when CI is green\", \"remind me in an hour\").", "dim")]
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
  if (pending.length > 0) lines.push(line(`/wakeups cancel <id> stops one${pending.some((wake) => wake.trigger === "webhook") ? "; /wakeups secret <id> shows a webhook's secret" : ""}.`, "dim", 2))
  return lines
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
