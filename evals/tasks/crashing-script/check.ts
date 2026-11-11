import { join } from "node:path"
import { fail, errorLine, pass, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["orders.json"])
const main = await run(["bun", "report.ts"], workspace)
if (main.code !== 0) fail(`bun report.ts still fails: ${errorLine(main.output)}`)
const expected = ["orders: 6", "customers: 4", "revenue: $437.49", "untagged: 2", "tag express: 3", "tag gift: 2", "tag wholesale: 1"]
if (main.stdout.trim() !== expected.join("\n")) fail(`bun report.ts printed the wrong summary: ${main.stdout.trim().split("\n").join(" | ")}`)

// A second export the agent has never seen: missing and null tags in other positions.
const hidden = join(workspace, ".grader-orders.json")
await Bun.write(
  hidden,
  JSON.stringify([
    { id: "x1", customer: "a", totalCents: 100 },
    { id: "x2", customer: "b", totalCents: 250, tags: null },
    { id: "x3", customer: "a", totalCents: 5, tags: ["promo"] },
  ]),
)
const other = await run(["bun", "report.ts", hidden], workspace)
await Bun.file(hidden).delete()
const otherExpected = ["orders: 3", "customers: 2", "revenue: $3.55", "untagged: 2", "tag promo: 1"]
if (other.code !== 0) fail(`report.ts crashes on another export with missing or null tags: ${errorLine(other.output)}`)
if (other.stdout.trim() !== otherExpected.join("\n")) fail(`report.ts mishandles missing or null tags: ${other.stdout.trim().split("\n").join(" | ")}`)
pass("report.ts prints the summary and tolerates orders without tags")
