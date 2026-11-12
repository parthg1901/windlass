// The history (git log) shows the convention: "<area>: <lowercase summary>", a blank line, "Refs: #<issue>". Graded
// on the outcome: one or more new commits on top of the setup's history, the typo fixed in the committed tree, and
// the new commit(s) following the convention with "Refs: #77". The area name and the wording are free.
import { fail, pass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const git = async (...args: string[]) => {
  const result = await run(["git", ...args], workspace)
  if (result.code !== 0) fail(`git ${args.join(" ")} failed: ${result.output.trim().split("\n")[0]}`)
  return result.stdout
}
const subjects = (await git("log", "--format=%s")).trim().split("\n")
const setupCount = 4
if (subjects.length <= setupCount) fail("nothing was committed")
const committed = await git("show", "HEAD:src/upload.ts")
if (committed.includes("exeeds") || !committed.includes("exceeds")) fail("the committed src/upload.ts does not have the typo fixed")
const newCount = subjects.length - setupCount
for (let index = 0; index < newCount; index += 1) {
  const message = await git("log", "-1", "--format=%B", `HEAD~${index}`)
  const [subject = "", blank, ...body] = message.trimEnd().split("\n")
  if (!/^[a-z][a-z0-9-]*: [a-z0-9`]/.test(subject)) fail(`the commit subject "${subject}" does not follow the repository's "<area>: <lowercase summary>" convention`)
  if (subject.endsWith(".")) fail(`the commit subject "${subject}" ends with a period, unlike the history`)
  if (blank !== "" || !body.some((line) => /^Refs: #77$/.test(line.trim()))) fail(`the commit "${subject}" has no "Refs: #77" line after a blank line`)
}
pass("the typo is fixed and committed following the repository's message convention")
