// The report test fails because the CSV parser splits quoted fields on their commas and reads "1,234.50" as 1.
// The grader runs the original tests, then the parser on statements the agent has not seen (quoted fields with
// commas, quoted amounts with separators, negatives), and checks that formatting and the report were not bent to fit.
import { fail, importFrom, pass, requireOriginalTestsPass, requireUnchanged, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["fixtures/january.csv"])
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/report.test.ts", "src/money.test.ts", "src/csv.test.ts"])

type Row = { date: string; description: string; amount: number }
const { parseStatement } = await importFrom<{ parseStatement: (text: string) => Row[] }>(workspace, "src/csv.ts")
const { formatMoney } = await importFrom<{ formatMoney: (cents: number) => string }>(workspace, "src/money.ts")
const { totalsLine } = await importFrom<{ totalsLine: (rows: Row[]) => string }>(workspace, "src/report.ts")

const hidden = [
  "date,description,amount",
  '2026-02-01,"Desk, standing, oak","2,499.99"',
  "2026-02-02,Lunch,-18.40",
  '2026-02-03,"Refund","-1,100.00"',
  '2026-02-04,Consulting,"12,000.5"',
  "2026-02-05,Stamps,7",
].join("\n")
const rows = parseStatement(`${hidden}\n`)
const expected: Row[] = [
  { date: "2026-02-01", description: "Desk, standing, oak", amount: 249999 },
  { date: "2026-02-02", description: "Lunch", amount: -1840 },
  { date: "2026-02-03", description: "Refund", amount: -110000 },
  { date: "2026-02-04", description: "Consulting", amount: 1200050 },
  { date: "2026-02-05", description: "Stamps", amount: 700 },
]
for (const [index, want] of expected.entries()) {
  const got = rows[index]
  if (!got || got.date !== want.date || got.description !== want.description || got.amount !== want.amount) fail(`a statement line parsed as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
if (rows.length !== expected.length) fail(`a ${expected.length}-line statement parsed as ${rows.length} rows`)
for (const [cents, text] of [[0, "0.00"], [7, "0.07"], [-123456, "-1,234.56"], [99999999, "999,999.99"]] as const) {
  if (formatMoney(cents) !== text) fail(`formatMoney(${cents}) is ${formatMoney(cents)}, expected ${text}: the formatting was right`)
}
const line = totalsLine(expected)
if (line !== "Total: 13,389.09 (5 transactions)") fail(`totalsLine on a correct February is ${line}`)
pass("the parser handles quoted fields and separators; formatting and the report still behave")
