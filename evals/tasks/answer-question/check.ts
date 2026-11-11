import { join } from "node:path"
import { fail, pass, pristine, readTree, workspaceArg } from "../../grader.ts"

// The app overrides attempts=4 and baseDelayMs=900: three retries waiting 900, 1800 and 3600 ms (below the 5000 cap).
const EXPECTED = 3600

const workspace = workspaceArg()
const original = await pristine(import.meta.dir)
const files = await readTree(workspace)
for (const [path, text] of original) {
  if (!files.has(path)) fail(`${path} was deleted`)
  if (files.get(path) !== text) fail(`${path} was changed, but the task was read-only`)
}
const extra = [...files.keys()].filter((path) => !original.has(path) && path !== "answer.txt")
if (extra.length > 0) fail(`unexpected new files: ${extra.join(", ")}`)
const answer = Bun.file(join(workspace, "answer.txt"))
if (!(await answer.exists())) fail("answer.txt was not written")
const numbers = ((await answer.text()).replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(\.\d+)?/g) ?? []).map(Number)
if (numbers.length === 0) fail("answer.txt contains no number")
if (new Set(numbers).size > 1) fail(`answer.txt contains several numbers (${numbers.join(", ")}); expected just one`)
if (numbers[0] !== EXPECTED) fail(`answer.txt says ${numbers[0]}, which is wrong`)
pass("the answer is correct and nothing else changed")
