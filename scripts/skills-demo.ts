/**
 * Skills against the example skills: what discovery finds, what the model is
 * told (the index, appended), what loading one returns, and what an edit
 * during the session appends.
 *
 *   bun scripts/skills-demo.ts
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import type { CallId, MessageId, SessionId } from "../packages/core/src/id.ts"
import { createInterrupt } from "../packages/core/src/interrupt.ts"
import { discoverSkills } from "../packages/core/src/skills/discover.ts"
import { skillIndexSource, skillIndexUpdate } from "../packages/core/src/skills/skill-index.ts"
import { SKILL_TOOL, skillTool } from "../packages/core/src/skills/tool.ts"
import { createToolRuntime } from "../packages/core/src/tool/runtime.ts"
import { noBlobStore, specOf } from "../packages/core/src/tool/tool.ts"

const base = realpathSync(mkdtempSync(join(tmpdir(), `${brand.binary}-skills-demo-`)))
const repo = join(base, "repo")
const cwd = join(repo, "app")
const configDir = join(base, "config")
mkdirSync(join(repo, ".git"), { recursive: true })
mkdirSync(cwd, { recursive: true })
// The example skills as a project would keep them, in .claude/skills at the repository root.
cpSync(join(import.meta.dir, "../examples/skills"), join(repo, ".claude", "skills"), { recursive: true })
// A user-level skill with the same name as a project one: the project's wins.
await Bun.write(join(configDir, "skills", "commit", "SKILL.md"), "---\nname: commit\ndescription: The user's own commit habits.\n---\nUser-level body.\n")
// A broken one, reported to the user and never to the model.
await Bun.write(join(cwd, ".agents", "skills", "release", "SKILL.md"), "---\nname: release\nsteps: [build, tag, publish]\n---\nRelease steps.\n")

const rule = (title: string) => console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`)
const show = (path: string) => path.replaceAll(base, "<tmp>")
const discover = () => discoverSkills({ cwd, configDir })

rule("Discovery (for the user)")
const set = discover()
console.log("roots, highest precedence first:")
for (const root of set.roots) console.log(`  ${root.scope.padEnd(7)} ${show(root.dir)}`)
console.log("skills:")
for (const skill of set.skills) console.log(`  ${skill.name.padEnd(16)} ${show(skill.path)}`)
console.log("problems:")
for (const problem of set.problems) console.log(`  ${problem.severity.padEnd(8)} ${show(problem.path)}: ${show(problem.reason)}`)

rule("The tool list entry (fixed, names no skill)")
const tool = skillTool({ configDir })
console.log(JSON.stringify({ ...specOf(tool), effect: tool.effect }, null, 2))

rule("What the model is told: the index, appended at a step boundary")
let known: string | null | undefined
const step = (when: string) => {
  const update = skillIndexUpdate(known, skillIndexSource(discover().skills))
  if (update === null) return console.log(`[${when}] index unchanged: nothing appended`)
  known = update.fingerprint
  console.log(`[${when}] appended instruction message (source "skills", fingerprint ${update.fingerprint?.slice(0, 12) ?? "null"}):\n${show(update.text)}`)
}
step("first step boundary")
step("next step boundary")

rule("Loading a skill")
const runtime = createToolRuntime({ tools: [tool], spillDir: join(base, "spill"), putBlob: noBlobStore })
let calls = 0
const load = async (name: string) => {
  calls += 1
  const outcome = await runtime.run({
    name: SKILL_TOOL,
    argumentsText: JSON.stringify({ name }),
    context: { sessionId: "ses_demo" as SessionId, messageId: "msg_demo" as MessageId, callId: `call_${calls}` as CallId, cwd, signal: createInterrupt().signal, progress: () => {} },
  })
  const lines = show(outcome.settlement.output).split("\n")
  const shown = lines.length > 16 ? [...lines.slice(0, 8), `  ... (${lines.length - 12} lines of the body not shown here) ...`, ...lines.slice(-4)] : lines
  console.log(`> skill ${JSON.stringify({ name })}\n[${outcome.kind}, ${outcome.settlement.outcome}]\n${shown.join("\n")}\n`)
}
await load("harness-testing")
await load("comit")
await load("release")

rule("A skill is edited and another added during the session")
await Bun.write(
  join(repo, ".claude", "skills", "commit", "SKILL.md"),
  "---\nname: commit\ndescription: How to commit in a shared working tree. Use whenever you are asked to commit.\n---\nVersion two of the instructions.\n",
)
await Bun.write(join(cwd, ".agents", "skills", "changelog", "SKILL.md"), "---\nname: changelog\ndescription: How to write a changelog entry.\n---\nKeep it short.\n")
step("next step boundary")
await load("commit")

rmSync(base, { recursive: true, force: true })
