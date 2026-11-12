/**
 * The skill index: what the model is told about the skills that exist, name
 * and description only. It is an instruction source, appended to the
 * conversation when it first has something to say and again only when its
 * fingerprint changes (a skill added, removed or edited), never part of the
 * frozen prefix.
 *
 * Pure and bounded: skills sorted by name, each description collapsed to one
 * line of at most `maxDescriptionChars`, the whole text at most `maxChars`.
 * Skills that do not fit are listed by name only, and past that counted; the
 * `skill` tool loads any of them by name.
 */
import { fingerprint } from "../instructions/source.ts"
import { type Skill, byCodeUnits } from "./discover.ts"

/** The `source` of the instruction messages that carry the index. */
export const SKILLS_INDEX_KEY = "skills"

export interface SkillIndexLimits {
  readonly maxChars: number
  readonly maxDescriptionChars: number
}

export const SKILL_INDEX_LIMITS: SkillIndexLimits = { maxChars: 8000, maxDescriptionChars: 300 }

const INTRO =
  "Skills are instructions for particular kinds of task, kept as files. When a task matches a skill's description, load the skill with the skill tool (by name) before you start, and follow it."

/** The index body, or `null` when there are no skills. */
export function renderSkillIndex(skills: readonly Pick<Skill, "name" | "description">[], limits: SkillIndexLimits = SKILL_INDEX_LIMITS): string | null {
  if (skills.length === 0) return null
  const sorted = [...skills].sort((a, b) => byCodeUnits(a.name, b.name))
  const lines = sorted.map((skill) => `- ${skill.name}: ${cut(skill.description.replace(/\s+/g, " ").trim(), limits.maxDescriptionChars)}`)
  const text = (listed: number, named: number) => {
    const parts = [INTRO, "", ...lines.slice(0, listed)]
    const names = sorted.slice(listed, listed + named).map((skill) => skill.name)
    const rest = sorted.length - listed - named
    if (names.length > 0) parts.push(`Also available, without descriptions here: ${names.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}.`)
    else if (rest > 0) parts.push(`And ${rest} more skills not listed here.`)
    return parts.join("\n")
  }
  // The most described skills that fit, then the most names; the same skills always give the same text.
  let listed = sorted.length
  while (listed > 0 && text(listed, 0).length > limits.maxChars && text(listed, sorted.length - listed).length > limits.maxChars) listed -= 1
  let named = sorted.length - listed
  while (named > 0 && text(listed, named).length > limits.maxChars) named -= 1
  return text(listed, named)
}

/** The index as an instruction source, or `null` when there are no skills. */
export function skillIndexSource(skills: readonly Pick<Skill, "name" | "description">[], limits?: SkillIndexLimits): { readonly key: string; readonly value: string } | null {
  const value = renderSkillIndex(skills, limits)
  return value === null ? null : { key: SKILLS_INDEX_KEY, value }
}

/**
 * What to append so the model's index matches `source`, given the
 * fingerprint of the index it was last given (`null` or `undefined`: none,
 * or it was told there are none). `null` when nothing changed. The engine
 * stores the text and fingerprint in an `instruction.appended` event with
 * source `SKILLS_INDEX_KEY`.
 */
export function skillIndexUpdate(
  known: string | null | undefined,
  source: { readonly value: string } | null,
): { readonly text: string; readonly fingerprint: string | null } | null {
  if (source === null) {
    if (known === null || known === undefined) return null
    return { text: "There are no skills any more. Disregard the list of skills you were given before.", fingerprint: null }
  }
  const current = fingerprint(source.value)
  if (current === known) return null
  const notice = known === null || known === undefined ? "Skills you can load:" : "The skills have changed. This list replaces the one you were given before:"
  return { text: `${notice}\n${[`<skills lines="${source.value.split("\n").length}">`, source.value, "</skills>"].join("\n")}`, fingerprint: current }
}

function cut(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`
}
