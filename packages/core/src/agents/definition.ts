/**
 * One agent definition: a Markdown file whose front matter names and
 * describes the agent and may set its model, its reasoning effort and its
 * restrictions, and whose body is its instructions.
 *
 *   ---
 *   name: reviewer
 *   description: Reviews a change without editing anything.
 *   effects: read
 *   disallowed-tools: shell
 *   approval: ask
 *   ---
 *   You review code. ...
 *
 * Pure: `parseAgentDefinition` takes the file's text. The front matter is
 * read by the skills module's parser (`skills/frontmatter.ts`), which is
 * strict about structure and forgiving about style; lists may be written
 * `a, b`, `[a, b]` or as a block of `- a` lines.
 *
 * A restriction that cannot be read makes the whole definition unusable,
 * never a definition without that restriction: an agent the user believes is
 * read-only must not run with every tool because of a typo.
 */
import { fingerprint } from "../instructions/source.ts"
import { parseFrontMatter } from "../skills/frontmatter.ts"
import type { ToolEffect } from "../tool/tool.ts"

export const MAX_AGENT_NAME_LENGTH = 64
export const MAX_AGENT_DESCRIPTION_LENGTH = 1024
/** A definition longer than this is skipped: its body is part of every request of a session that runs as it. */
export const MAX_AGENT_BYTES = 64 * 1024

/** The effect classes of `tool/tool.ts`, in their order there. */
export const EFFECTS: readonly ToolEffect[] = ["read", "write", "exec", "network"]
/** The approval modes of `approval/policy.ts`, strictest first. */
export const APPROVAL_MODES = ["ask", "auto", "full"] as const
export type AgentApprovalMode = (typeof APPROVAL_MODES)[number]

/** The name that means "no agent" wherever an agent is chosen; no definition may take it. */
export const NO_AGENT = "none"

/**
 * What an agent may not do. Every field only takes away: there is no way to
 * write a restriction that lets a call run that the approval layer would
 * otherwise ask about or refuse.
 */
export interface AgentRestrictions {
  /** The effect classes its calls may have; `null`: any. */
  readonly effects: readonly ToolEffect[] | null
  /** The only tools it may call (compared ignoring case); `null`: any. */
  readonly tools: readonly string[] | null
  /** Tools it may never call (compared ignoring case). */
  readonly deniedTools: readonly string[]
  /** An approval mode that applies while it runs, when stricter than the user's; `null`: the user's. */
  readonly approval: AgentApprovalMode | null
}

export const NO_RESTRICTIONS: AgentRestrictions = { effects: null, tools: null, deniedTools: [], approval: null }

export interface ParsedAgent {
  readonly name: string
  readonly description: string
  /** The instructions: the file after its front matter, trimmed. */
  readonly body: string
  /** `null`: the session's (or the parent's) model. */
  readonly model: string | null
  /** `null`: the session's (or the parent's) reasoning effort. */
  readonly effort: string | null
  readonly restrictions: AgentRestrictions
  /** SHA-256 of everything above: the version of the definition a session was given. */
  readonly fingerprint: string
}

export type AgentParse =
  | { readonly ok: true; readonly agent: ParsedAgent; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** Keys other harnesses use that would do something here if they were read. They are not, and the user is told so. */
const NOT_READ: Readonly<Record<string, string>> = {
  permissionMode: "`permissionMode` is not read here; an agent tightens the approval mode with `approval: ask` (or `auto`), and can never loosen it",
  "permission-mode": "`permission-mode` is not read here; an agent tightens the approval mode with `approval: ask` (or `auto`), and can never loosen it",
  mcpServers: "`mcpServers` is not read here: a definition does not start servers",
  hooks: "`hooks` is not read here: a definition does not run commands",
}

/**
 * Reads one definition. `fallbackName` (the file name without `.md`) is the
 * name when the front matter has none.
 */
export function parseAgentDefinition(text: string, fallbackName: string): AgentParse {
  const parsed = parseFrontMatter(text)
  if (!parsed.ok) return parsed
  const fields = parsed.fields
  const warnings: string[] = []
  const name = (fields.get("name") ?? "").trim() || fallbackName
  if (name.length > MAX_AGENT_NAME_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return { ok: false, reason: `its name ${JSON.stringify(name)} is not a name of letters, digits, '-', '_' and '.' of at most ${MAX_AGENT_NAME_LENGTH} characters` }
  if (name.toLowerCase() === NO_AGENT) return { ok: false, reason: `"${NO_AGENT}" cannot be an agent's name: it is how a user says "no agent"` }
  const description = (fields.get("description") ?? "").replace(/\s+/g, " ").trim()
  if (description === "") return { ok: false, reason: "its front matter has no `description`, which is how the user and the model know what it is for" }
  if (!fields.has("name")) warnings.push(`it has no \`name\`; the file name "${fallbackName}" is used`)
  else if (name !== fallbackName) warnings.push(`its name "${name}" differs from its file name "${fallbackName}.md"`)
  if (description.length > MAX_AGENT_DESCRIPTION_LENGTH) warnings.push(`its description is ${description.length} characters; the list of agents shows only the start`)
  if (parsed.body === "") warnings.push("it has no instructions after the front matter")
  for (const key of Object.keys(NOT_READ)) if (fields.has(key)) warnings.push(NOT_READ[key]!)

  const model = setting(fields.get("model"), /^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "model")
  if (!model.ok) return model
  const effort = setting(fields.get("effort") ?? fields.get("reasoning-effort"), /^[A-Za-z]+$/, "effort")
  if (!effort.ok) return effort
  if (fields.has("effort") && fields.has("reasoning-effort")) return { ok: false, reason: "it sets both `effort` and `reasoning-effort`; keep one" }

  const effects = list(text, fields, "effects")
  if (!effects.ok) return effects
  let effectList: ToolEffect[] | null = null
  if (effects.items !== null) {
    const unknown = effects.items.find((item) => !(EFFECTS as readonly string[]).includes(item.toLowerCase()))
    if (unknown !== undefined) return { ok: false, reason: `\`effects\` names ${JSON.stringify(unknown)}, which is not an effect class (${EFFECTS.join(", ")})` }
    const wanted = new Set(effects.items.map((item) => item.toLowerCase()))
    effectList = EFFECTS.filter((effect) => wanted.has(effect))
  }

  const tools = list(text, fields, "tools")
  if (!tools.ok) return tools
  const toolList = tools.items !== null && tools.items.length === 1 && tools.items[0] === "*" ? null : tools.items
  if (toolList !== null) {
    const bad = toolList.find((item) => !TOOL_NAME.test(item))
    if (bad !== undefined) return { ok: false, reason: badTool("tools", bad) }
  }
  if (fields.has("disallowed-tools") && fields.has("disallowedTools")) return { ok: false, reason: "it has both `disallowed-tools` and `disallowedTools`; keep one" }
  const deniedKey = fields.has("disallowedTools") ? "disallowedTools" : "disallowed-tools"
  const denied = list(text, fields, deniedKey)
  if (!denied.ok) return denied
  const deniedList = denied.items ?? []
  const badDenied = deniedList.find((item) => !TOOL_NAME.test(item))
  if (badDenied !== undefined) return { ok: false, reason: badTool(deniedKey, badDenied) }

  const approvalRaw = fields.get("approval")
  let approval: AgentApprovalMode | null = null
  if (approvalRaw !== undefined) {
    const value = approvalRaw.trim().toLowerCase()
    if (!(APPROVAL_MODES as readonly string[]).includes(value)) return { ok: false, reason: `\`approval\` is ${JSON.stringify(approvalRaw)}; it is one of ${APPROVAL_MODES.join(", ")}` }
    approval = value as AgentApprovalMode
  }

  const restrictions: AgentRestrictions = { effects: effectList, tools: toolList === null ? null : dedupe(toolList), deniedTools: dedupe(deniedList), approval }
  const agent = { name, description, body: parsed.body, model: model.value, effort: effort.value === null ? null : effort.value.toLowerCase(), restrictions }
  return { ok: true, agent: { ...agent, fingerprint: definitionFingerprint(agent) }, warnings }
}

/** The fingerprint of a definition's meaning: what a session that runs as it is given, nothing about where the file is. */
export function definitionFingerprint(agent: Omit<ParsedAgent, "fingerprint">): string {
  const r = agent.restrictions
  return fingerprint(JSON.stringify([agent.name, agent.description, agent.model, agent.effort, r.effects, r.tools, r.deniedTools, r.approval, agent.body]))
}

const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/

function badTool(key: string, item: string) {
  return /[()*]/.test(item)
    ? `\`${key}\` has ${JSON.stringify(item)}: tool patterns with arguments or wildcards are not supported here; name whole tools`
    : `\`${key}\` has ${JSON.stringify(item)}, which is not a tool name`
}

function setting(raw: string | undefined, pattern: RegExp, key: string): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: null }
  const value = raw.trim()
  if (value === "" || value.toLowerCase() === "inherit") return { ok: true, value: null }
  if (!pattern.test(value)) return { ok: false, reason: `\`${key}\` is ${JSON.stringify(raw)}, which is not a ${key} name` }
  return { ok: true, value }
}

/**
 * A list-valued key: `a, b`, `[a, b]`, or (the parser gives an empty value
 * for a nested block) `- a` lines under the key. `items` is `null` when the
 * key is absent. A key that is present with no items is an error: leaving a
 * restriction empty by mistake must not read as "no restriction".
 */
function list(text: string, fields: ReadonlyMap<string, string>, key: string): { ok: true; items: string[] | null } | { ok: false; reason: string } {
  const raw = fields.get(key)
  if (raw === undefined) return { ok: true, items: null }
  let value = raw.trim()
  let items: string[]
  if (value === "") items = blockList(text, key)
  else {
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) return { ok: false, reason: `\`${key}\` starts a list with \`[\` that is not closed` }
      value = value.slice(1, -1)
    }
    items = value.split(",").map(unquote)
  }
  items = items.filter((item) => item !== "")
  if (items.length === 0) return { ok: false, reason: `\`${key}\` is empty; leave the key out for no restriction, or name at least one item` }
  return { ok: true, items }
}

/** The `- item` lines under a top-level `key:` of the front matter. */
function blockList(text: string, key: string): string[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n")
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."))
  const start = lines.findIndex((line, index) => index > 0 && index < end && new RegExp(`^${key.replace(/[.-]/g, "\\$&")}\\s*:`).test(line))
  if (start === -1) return []
  const items: string[] = []
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index]!
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue
    if (!/^\s/.test(line)) break
    const match = /^\s+-\s*(.*)$/.exec(line)
    if (match !== null) items.push(unquote(match[1]!.replace(/\s+#.*$/, "")))
  }
  return items
}

function unquote(item: string): string {
  const value = item.trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1).trim()
  return value
}

function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>()
  return items.filter((item) => !seen.has(item.toLowerCase()) && (seen.add(item.toLowerCase()), true))
}
