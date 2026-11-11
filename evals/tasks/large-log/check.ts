import { join } from "node:path"
import { fail, pass, workspaceArg } from "../../grader.ts"
import { events } from "./workspace/gen.ts"

const workspace = workspaceArg()
const users = new Set<string>()
const hasher = new Bun.CryptoHasher("sha256")
for (const line of events()) {
  hasher.update(line + "\n")
  if (line.includes(" level=ERROR ") && line.includes(" code=E42 ")) users.add(line.split(" user=")[1]!.split(" ")[0]!)
}
const log = Bun.file(join(workspace, "data/events.log"))
if (!(await log.exists())) fail("data/events.log was deleted")
if (new Bun.CryptoHasher("sha256").update(await log.arrayBuffer()).digest("hex") !== hasher.digest("hex")) fail("data/events.log was modified")
const answer = Bun.file(join(workspace, "answer.txt"))
if (!(await answer.exists())) fail("answer.txt was not written")
const numbers = ((await answer.text()).replace(/(\d),(\d{3})/g, "$1$2").match(/\d+/g) ?? []).map(Number)
if (numbers.length !== 1) fail(`answer.txt should hold exactly one number, found ${numbers.length}`)
if (numbers[0] !== users.size) fail(`answer.txt says ${numbers[0]}, which is wrong`)
pass(`answer.txt holds the right count (${users.size})`)
