/**
 * What both front ends say about hooks and language servers: `/hooks` and
 * `/lsp`, the question about one a project's configuration names (the
 * engine's own words, with where it is defined and what each answer does),
 * what to do in a run with nobody to ask, and what a hook did to a call or
 * to a turn's ending and what the language servers said about an edit, read
 * from the records the engine keeps (`hook.ran`, `tool.settled.diagnostics`,
 * `hooks.unsatisfied`), never from the text the model was shown.
 *
 * Shared by the line CLI and the TUI (which maps tones onto its theme).
 */
import { type EventData, brand } from "@windlass/core"
import type { HookInfo, HooksStateResult, LspServerInfo, LspStateResult } from "@windlass/acp/extensions"
import { type Line, type LineTone, commandLine, definedInLines, shownCommand } from "./features.ts"

const line = (text: string, tone: LineTone = "plain", indent = 0): Line => ({ text, tone, indent })

const USER_FILE = `~/.config/${brand.directory}/config.json`
const PROJECT_FILE = `.${brand.directory}/config.json`

export type HookRecord = EventData<"hook.ran">
export type DiagnosticsRecord = NonNullable<EventData<"tool.settled">["diagnostics"]>

const POINT_WORDS: Record<HookInfo["point"], string> = { beforeTool: "before a tool call", afterTool: "after a tool call", stop: "when a turn is about to end" }
const POINT_HEADS: Record<HookInfo["point"], string> = { beforeTool: "Before a tool call", afterTool: "After a tool call", stop: "When a turn is about to end" }

// ---------------------------------------------------------------- /hooks

/** What a hook applies to, in a few words. */
export function hookApplies(hook: Pick<HookInfo, "point" | "tools" | "paths">): string | null {
  if (hook.point === "stop") return null
  return `applies to ${hook.tools === null ? "every tool" : hook.tools.join(", ")}${hook.paths === null ? "" : `, for paths matching ${hook.paths.join(", ")}`}`
}

/** A hook's state in a few words. */
export function hookStateWords(hook: HookInfo): string {
  if (hook.state === "awaiting_approval") return "waiting for your approval: not run"
  if (hook.state === "failed") return "failed the last time it ran"
  return "in force"
}

/** `/hooks`: every hook by the point it runs at, with its command, what it applies to, its state and where it is defined. */
export function hooksLines(state: HooksStateResult): Line[] {
  if (!state.available) return [line("This engine runs no hooks.", "dim")]
  if (state.hooks.length === 0)
    return [
      line("No hook is configured for this session.", "dim"),
      line(`A hook is a command run before a tool call, after one, or when a turn is about to end. Name one under "hooks": { "beforeTool": [ ... ], "afterTool": [ ... ], "stop": [ ... ] } in your file (${USER_FILE}) or the project's (${PROJECT_FILE}).`, "dim", 2),
    ]
  const lines: Line[] = [line(`Hooks (${state.hooks.length}):`, "bold")]
  for (const point of ["beforeTool", "afterTool", "stop"] as const) {
    const hooks = state.hooks.filter((hook) => hook.point === point)
    if (hooks.length === 0) continue
    lines.push(line(`${POINT_HEADS[point]}${point === "stop" ? ` (the agent is sent back at most ${state.maxStopRounds === 1 ? "once" : `${state.maxStopRounds} times`} per turn)` : ""}:`, "plain", 2))
    for (const hook of hooks) {
      const tone: LineTone = hook.state === "in_force" ? "ok" : "warn"
      lines.push(line(`${hook.name} · ${hookStateWords(hook)}`, tone, 4))
      lines.push(line(`runs ${hook.command.split("\n").join(" ⏎ ")}`, "dim", 6))
      const how = [hookApplies(hook), `at most ${hook.timeoutSeconds} s`, hook.sandbox ? null : "outside the sandbox (sandbox: false)", hook.point === "beforeTool" && hook.onError === "allow" ? "a call goes through when it cannot answer (onError: allow)" : null].filter((part) => part !== null)
      lines.push(line(how.join(" · "), "dim", 6))
      lines.push(...definedInLines(hook.origin, hook.file, 6))
      if (hook.error !== null) lines.push(line(`why: ${hook.error}${hook.point === "beforeTool" && hook.onError === "refuse" ? " (a call it applies to is refused while it cannot answer)" : ""}`, "warn", 6))
      if (hook.state === "awaiting_approval") lines.push(line(`/hooks approve ${hook.name} allows it for this project (you are asked first).`, "dim", 6))
    }
  }
  for (const ignored of state.ignored) lines.push(line(`Not followed (the project's file asks for more than yours allows): ${ignored}`, "warn", 2))
  return lines
}

/**
 * The engine's question about a project's hook, as the parts a front end
 * lays out: its first sentence, the command, and the sentences after it
 * (what it applies to, how it runs). Every word is the engine's.
 */
export function hookQuestionParts(hook: HookInfo): { readonly title: string; readonly command: string; readonly details: string[] } {
  const parts = (hook.question ?? "").split("\n")
  const title = (parts[0] ?? "").replace(/:\s*$/, "").trim()
  const details = parts.slice(1).filter((part) => part.trim() !== "" && !part.startsWith("    "))
  return { title: title === "" ? `This project's configuration asks to run a hook "${hook.name}" ${POINT_WORDS[hook.point]}` : title, command: hook.command, details }
}

export const HOOK_ALLOW = "allow it for this project and remember that (30 days, this exact definition: an edited one is asked about again); it runs from the next call it applies to"
export const hookNotNow = (hook: Pick<HookInfo, "name">): string => `not now: it is not run, and the work goes on as if it were not there; /hooks approve ${hook.name} asks again`

/** The question about a project's hook at the line CLI's prompt. */
export function hookQuestionLines(hook: HookInfo): Line[] {
  const question = hookQuestionParts(hook)
  return [
    line(`? ${question.title}:`, "bold"),
    ...question.command.split("\n").map((part) => commandLine(part)),
    ...question.details.map((detail) => line(detail, "dim", 2)),
    ...(hook.file === null ? [] : definedInLines(null, hook.file, 2)),
    line(`y  ${HOOK_ALLOW}`, "dim", 2),
    line(`n  ${hookNotNow(hook)}`, "dim", 2),
  ]
}

/** In a run with nobody to ask: how to approve the project's hooks that were skipped (the engine said that they were). */
export function hooksUnattendedText(hooks: readonly HookInfo[]): string {
  const names = [...new Set(hooks.map((hook) => hook.name))]
  const one = names.length === 1
  return `Approving ${one ? `the hook "${names[0]}"` : `these hooks (${names.join(", ")})`} needs someone at the terminal: run \`${brand.binary}\` in this directory and answer the ${one ? "question" : "questions"} it asks (or type /hooks approve ${one ? names[0] : "<name>"}). The approval is remembered for this project; until then ${one ? "the hook is" : "they are"} skipped.`
}

// ---------------------------------------------------------------- /lsp

/** A language server's state in a few words. */
export function lspStateWords(server: LspServerInfo): string {
  switch (server.state) {
    case "running":
      return server.processes.length > 1 ? `running · ${server.processes.filter((process) => process.state === "running").length} of ${server.processes.length} workspace roots` : "running"
    case "starting":
      return "starting…"
    case "failed":
      return "failed: it is started again at a later edit"
    case "awaiting_approval":
      return "waiting for your approval: not started"
    case "disabled":
      return "disabled (enabled: false in its definition)"
    case "stopped":
      return "stopped"
    case "not_started":
      return "not started yet: it starts when the agent reads or edits a file it serves"
  }
}

/** The files a server serves, as its glob patterns, separated by commas. */
export function servedFiles(server: Pick<LspServerInfo, "languages">): string {
  return server.languages.flatMap((language) => language.patterns).join(", ")
}

/** `/lsp`: every language server with its state, what it runs, the files it serves and where it is defined. */
export function lspLines(state: LspStateResult): Line[] {
  if (!state.available) return [line("This engine offers no language-server diagnostics.", "dim")]
  if (state.servers.length === 0)
    return [
      line("No language server is configured for this session.", "dim"),
      line(`A language server's diagnostics are added to the agent's edits as a short note. Name one under "lsp": { "servers": { ... } } in your file (${USER_FILE}) or the project's (${PROJECT_FILE}); it must already be installed.`, "dim", 2),
    ]
  const lines: Line[] = [line(`Language servers (${state.servers.length}):`, "bold")]
  if (state.off !== null) lines.push(line(state.off, "warn", 2))
  else if (state.waitMs !== null) lines.push(line(`An edit's result waits at most ${state.waitMs} ms for diagnostics; only what the edit made worse is shown to the agent.`, "dim", 2))
  for (const server of state.servers) {
    const tone: LineTone = server.state === "running" ? "ok" : server.state === "failed" || server.state === "awaiting_approval" ? "warn" : "dim"
    lines.push(line(`${server.name} · ${lspStateWords(server)}`, tone, 2))
    lines.push(line(`runs ${shownCommand(server.argv, server.command)}`, "dim", 4))
    lines.push(line(`serves ${servedFiles(server)}`, "dim", 4))
    lines.push(...definedInLines(server.origin, server.file, 4))
    if (server.error !== null) lines.push(line(`why: ${server.error}`, "warn", 4))
    if (server.processes.length > 1) for (const process of server.processes) lines.push(line(`${process.root} · ${process.state.replace(/_/g, " ")}${process.error === null ? "" : `: ${process.error}`}`, "dim", 6))
    if (server.state === "awaiting_approval") lines.push(line(`/lsp approve ${server.name} allows it for this project (you are asked first).`, "dim", 4))
  }
  return lines
}

export const lspQuestionTitle = (server: Pick<LspServerInfo, "name">): string => `Start the language server "${server.name}" that this project's configuration names?`
export const LSP_ALLOW = "allow it for this project and remember that (30 days, this exact definition: an edited one is asked about again); it starts at the next file it serves"
export const lspNotNow = (server: Pick<LspServerInfo, "name">): string => `not now: it is not started and edits get no diagnostics from it; /lsp approve ${server.name} asks again`

/** The question about a project's language server at the line CLI's prompt, in the engine's own words. */
export function lspQuestionLines(server: LspServerInfo): Line[] {
  const question = server.question
  return [
    line(`? ${lspQuestionTitle(server)}`, "bold"),
    commandLine(shownCommand(server.argv, question?.subject ?? server.command)),
    ...(server.file === null ? [] : definedInLines(null, server.file, 2)),
    ...(question?.details ?? []).map((detail) => line(detail, "dim", 2)),
    line(`y  ${LSP_ALLOW}`, "dim", 2),
    line(`n  ${lspNotNow(server)}`, "dim", 2),
  ]
}

/** In a run with nobody to ask: how to approve the project's language servers that were not started (the engine said that they were not). */
export function lspUnattendedText(servers: readonly LspServerInfo[]): string {
  const names = servers.map((server) => server.name)
  const one = names.length === 1
  return `Approving ${one ? `the language server "${names[0]}"` : `these language servers (${names.join(", ")})`} needs someone at the terminal: run \`${brand.binary}\` in this directory and answer the ${one ? "question" : "questions"} it asks (or type /lsp approve ${one ? names[0] : "<name>"}). The approval is remembered for this project; until then edits get no diagnostics from ${one ? "it" : "them"}.`
}

// ---------------------------------------------------------------- what a hook did

/** Why a hook could not answer, in a few words: `timed out after 10 s`, `it exited with code 7`. */
export function hookFailureWords(record: Pick<HookRecord, "failure" | "detail">): string {
  return record.detail ?? record.failure?.replace(/_/g, " ") ?? "it failed"
}

/** The end of what a hook printed for the user (its stderr), as one line; `null` when it printed nothing. */
export function hookPrinted(record: Pick<HookRecord, "forUser">): string | null {
  const lines = record.forUser.split("\n").map((part) => part.trim()).filter((part) => part !== "")
  const last = lines.at(-1)
  if (last === undefined) return null
  return lines.length === 1 ? last : `${last} (the last of ${lines.length} lines)`
}

/** What a call's row says instead of its own outcome when a before hook kept the call from running; `null` when none did. */
export function hookRefusal(records: readonly HookRecord[], started: boolean, output: string): { readonly head: string; readonly reason: string | null } | null {
  if (started) return null
  const before = records.filter((record) => record.point === "beforeTool")
  const refused = before.find((record) => record.answer === "no")
  if (refused !== undefined) return { head: `refused by the hook "${refused.name}"`, reason: refused.toModel }
  const failed = before.find((record) => record.answer === "failed")
  // A hook that could not answer refuses the call unless it says `onError: "allow"`; the refusal names the hook.
  if (failed !== undefined && output.includes(`"${failed.name}"`)) return { head: `refused: the hook "${failed.name}" must allow it and could not answer (${hookFailureWords(failed)})`, reason: null }
  return null
}

/**
 * The lines under a call's row for the hooks that applied to it: a note an
 * after hook added (the agent reads it with the result), a hook that could
 * not answer, and what a hook printed for the user. A before hook's refusal
 * is the row itself (`hookRefusal`). `failures: false` leaves out the hooks
 * that could not answer: the engine says each one in full as it happens, so
 * the row says it only where that sentence is not shown (a stored session).
 */
export function hookCallLines(records: readonly HookRecord[], started: boolean, failures: boolean): { readonly text: string; readonly tone: "dim" | "warn" }[] {
  const lines: { text: string; tone: "dim" | "warn" }[] = []
  for (const record of records) {
    if (record.point === "afterTool" && record.answer === "no") lines.push({ text: `note from the hook "${record.name}", added to the result: ${record.toModel ?? "(it gave no text)"}`, tone: "dim" })
    if (failures && record.answer === "failed" && (started || record.point !== "beforeTool"))
      lines.push({ text: `the hook "${record.name}" could not answer (${hookFailureWords(record)})${record.point === "beforeTool" ? "; the call ran (onError: allow)" : "; nothing was added to the result"}`, tone: "warn" })
    const printed = hookPrinted(record)
    if (printed !== null) lines.push({ text: `the hook "${record.name}" printed: ${printed}`, tone: "dim" })
  }
  return lines
}

/**
 * Stop hooks objected: who, and what each said to the agent. A hook's text
 * is on record only when it reached the agent, so an objection at the end of
 * a turn that ends anyway has none: what it said is where the agent was
 * last sent back.
 */
export function stopHookSentBack(records: readonly HookRecord[]): { readonly head: string; readonly reasons: string[] } {
  const objecting = records.filter((record) => record.point === "stop" && record.answer === "no")
  const names = objecting.map((record) => `"${record.name}"`)
  return {
    head: `${names.length === 1 ? `the stop hook ${names[0]}` : `the stop hooks ${names.join(", ")}`} did not let the turn end`,
    reasons: objecting.flatMap((record) => (record.toModel === null || record.toModel.trim() === "" ? [] : [objecting.length === 1 ? record.toModel : `${record.name}: ${record.toModel}`])),
  }
}

/** A turn that ended although stop hooks still objected: the ending's own words. */
export function unsatisfiedText(names: readonly string[]): string {
  return names.length === 1 ? `ended with the stop hook "${names[0]}" unsatisfied` : `ended with stop hooks unsatisfied: ${names.join(", ")}`
}

// ---------------------------------------------------------------- what the language servers said

/** What a row says when its result got diagnostics: how many new ones, from which server. `null` when no note was added. */
export function diagnosticsSummary(diagnostics: DiagnosticsRecord | undefined): string | null {
  if (diagnostics === undefined || !diagnostics.noteAdded) return null
  const servers = diagnostics.servers.filter((server) => server.new > 0)
  if (servers.length === 0) return null
  return servers.map((server) => `${server.new} new ${server.new === 1 ? "diagnostic" : "diagnostics"} from ${server.name}`).join(", ")
}
