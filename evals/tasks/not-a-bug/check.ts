// The code is right in this version (2.4.0): "1h30m" is 5400. The customer runs 2.2.1, which had the bug fixed in
// 2.3.0. The right outcome: nothing changed, and ANSWER.md says the code is right here (the 5400, or the old version).
import { fail, pass, pristine, readTree, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const before = await pristine(import.meta.dir)
const after = await readTree(workspace)
for (const [path, text] of before) {
  const now = after.get(path)
  if (now === undefined) fail(`${path} was deleted`)
  if (now !== text) fail(`${path} was changed, but nothing in this version is broken`)
}
const added = [...after.keys()].filter((path) => !before.has(path) && path !== "ANSWER.md")
if (added.length > 0) fail(`files were added: ${added.join(", ")}`)
const answer = after.get("ANSWER.md")
if (answer === undefined) fail("there is no ANSWER.md")
if (answer.trim().length < 30) fail("ANSWER.md is too short to explain anything")
const version = /2\.2\.1|2\.2\.x|2\.3(\.0)?|2\.4(\.0)?|old(er)? version|outdated|upgrad|lockfile/i.test(answer)
const value = /\b5,?400\b/.test(answer)
if (!version && !value) fail("ANSWER.md neither says this version returns 5400 nor that the customer runs an old version")
pass("nothing was changed and ANSWER.md explains it")
