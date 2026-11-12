/**
 * What `/mcp`, `/skills`, `/wakeups` and `/memory` say, and the MCP server
 * question, as lines with a tone: one judgement of what is worth saying,
 * shared by the line CLI and the TUI (which maps tones onto its theme). Every
 * line is a sentence a first-time user can act on: what is so, and what to do
 * next. Nothing here is ever cut: long paths and reasons wrap where they are shown.
 */
import { brand } from "@light-harness/core"
import type { McpServerInfo, McpStateResult, MemoryStateResult, SkillsResult, WakeListResult, WakeSecretResult } from "@light-harness/acp/extensions"

export type LineTone = "plain" | "dim" | "warn" | "error" | "ok" | "bold" | "accent"

export interface Line {
  readonly text: string
  readonly tone: LineTone
  /** Columns of indentation, kept when the line wraps. */
  readonly indent?: number
}

const line = (text: string, tone: LineTone = "plain", indent = 0): Line => ({ text, tone, indent })

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
      return "not started yet: servers start with the next message"
  }
}

function where(server: McpServerInfo): string {
  if (server.file === null) return "defined in a configuration file"
  return server.origin === "project" ? `defined in this project's file, ${server.file}` : `defined in your file, ${server.file}`
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
    if (server.target !== null) lines.push(line(`${server.transport === "http" ? "reached at" : "runs"} ${server.target}`, "dim", 4))
    lines.push(line(where(server), "dim", 4))
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
    line(question?.subject ?? server.target ?? "", "plain", 4),
    ...(server.file === null ? [] : [line(`defined in ${server.file}`, "dim", 2)]),
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
      lines.push(line(`from ${SCOPE_WORDS[skill.scope]}: ${skill.path}`, "dim", 4))
    }
  }
  const shadowed = result.problems.filter((problem) => problem.severity === "shadowed")
  const broken = result.problems.filter((problem) => problem.severity !== "shadowed")
  if (shadowed.length > 0) {
    lines.push(line(`Hidden by a skill of the same name (${shadowed.length}):`, "bold"))
    for (const problem of shadowed) {
      lines.push(line(problem.path, "dim", 2))
      lines.push(line(problem.reason, "dim", 4))
    }
  }
  if (broken.length > 0) {
    lines.push(line(`Not loaded (${broken.length}): fix the file and the next message picks it up`, "warn"))
    for (const problem of broken) {
      lines.push(line(problem.path, "warn", 2))
      lines.push(line(`${problem.severity === "warning" ? "loaded, but: " : ""}${problem.reason}`, "dim", 4))
    }
  }
  return lines
}

// ---------------------------------------------------------------- wake-ups

/** `/wakeups`: the session's wake-ups, pending first, in the engine's words; a webhook's URL, never its secret. */
export function wakeLines(result: WakeListResult): Line[] {
  if (!result.available) return [line("This engine has no wake-ups.", "dim")]
  if (result.wakeups.length === 0)
    return [line("This session has no wake-up. Ask the agent for one (\"tell me when CI is green\", \"remind me in an hour\").", "dim")]
  const pending = result.wakeups.filter((wake) => wake.state === "pending")
  const ended = result.wakeups.filter((wake) => wake.state !== "pending")
  const lines: Line[] = [line(`Wake-ups of this session: ${pending.length} pending${ended.length === 0 ? "" : `, ${ended.length} ended`}`, "bold")]
  if (!result.running && pending.length > 0)
    lines.push(line("Nothing in this process fires them (see docs/wake-ups.md, \"Where wake-ups fire today\"): one that comes due fires, late, in the first process that runs the scheduler.", "warn", 2))
  for (const wake of [...pending, ...ended]) {
    lines.push(line(`${wake.id} · ${wake.description}`, wake.state === "pending" ? "plain" : "dim", 2))
    for (const text of wake.lines) lines.push(line(text, "dim", 4))
  }
  if (pending.length > 0) lines.push(line(`/wakeups cancel <id> stops one${pending.some((wake) => wake.trigger === "webhook") ? "; /wakeups secret <id> shows a webhook's secret" : ""}.`, "dim", 2))
  return lines
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
  return { head: `wake-up${id === null ? "" : ` ${id}`}: ${why}${match?.[3] === undefined ? "" : ` (${match[3]})`} · not typed by you`, message }
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
