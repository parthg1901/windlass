/**
 * The `skill` tool: loads one skill's instructions by name.
 *
 * Its spec is a constant. It does not list the skills (in its description or
 * as an enum in its schema), since they change during a session and the tool
 * list must not; the index, an appended message, is how the model knows them.
 *
 * Every call discovers the skills afresh from the call's working directory,
 * so a skill edited during a session is loaded as it is now. Effect `read`.
 */
import type { Tool } from "../tool/tool.ts"
import { type SkillDiscoveryInput, type SkillSet, SKILL_FILE, discoverSkills, supportingFiles } from "./discover.ts"

export const SKILL_TOOL = "skill"

export interface SkillToolOptions extends Omit<SkillDiscoveryInput, "cwd"> {}

export interface SkillInput {
  readonly name: string
}

const DESCRIPTION =
  "Load a skill: the instructions for a particular kind of task. The list of skills you were given names and describes them. Returns the skill's instructions and the paths of its supporting files; read those with the read tool when the instructions refer to them."

export function skillTool(options: SkillToolOptions): Tool<SkillInput> {
  return {
    name: SKILL_TOOL,
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1, description: "The skill's name, as the list of skills shows it." } },
      required: ["name"],
      additionalProperties: false,
    },
    effect: "read",
    execute: async (input, context) => {
      const set = discoverSkills({ ...options, cwd: context.cwd })
      const wanted = input.name.trim()
      const skill = set.skills.find((candidate) => candidate.name === wanted) ?? set.skills.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase())
      if (skill === undefined)
        return { status: "error", output: notFound(wanted, set), truncation: null, attachments: [], display: { skill: { name: wanted, path: null, files: 0 } } }
      const files = supportingFiles(skill)
      const lines = [`<skill name="${skill.name}" path="${skill.path}">`, skill.body === "" ? "(This skill has no instructions.)" : skill.body, "</skill>"]
      if (files.files.length > 0) {
        lines.push("", `Supporting files of this skill (paths in its instructions are relative to ${skill.dir}):`, ...files.files.map((file) => `- ${file}`))
        if (files.omitted > 0) lines.push(`- and ${files.omitted} more files in ${skill.dir}`)
      }
      return {
        status: "success",
        output: lines.join("\n"),
        truncation: null,
        attachments: [],
        display: { skill: { name: skill.name, path: skill.path, files: files.files.length + files.omitted } },
      }
    },
  }
}

function notFound(name: string, set: SkillSet): string {
  // A skill with this name that could not be loaded: say why, which is what the user needs to fix.
  const broken = set.problems.find((problem) => problem.severity === "skipped" && problem.path.endsWith(`/${name}/${SKILL_FILE}`))
  if (broken !== undefined) return `The skill "${name}" (${broken.path}) could not be loaded: ${broken.reason}.`
  if (set.skills.length === 0) return `There is no skill named ${JSON.stringify(name)}. No skills are available.`
  const close = set.skills
    .map((skill) => ({ name: skill.name, distance: distance(name.toLowerCase(), skill.name.toLowerCase()) }))
    .filter((entry) => entry.distance <= Math.max(2, Math.floor(entry.name.length / 3)) || entry.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(entry.name.toLowerCase()))
    .sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : 1))
    .slice(0, 3)
    .map((entry) => entry.name)
  const all = set.skills.map((skill) => skill.name)
  const listing = all.length <= 30 ? all.join(", ") : `${all.slice(0, 30).join(", ")} and ${all.length - 30} more`
  return `There is no skill named ${JSON.stringify(name)}.${close.length > 0 ? ` Did you mean ${close.map((c) => JSON.stringify(c)).join(" or ")}?` : ""} Skills: ${listing}.`
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}
