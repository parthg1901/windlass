// The report is wrong because the last API page is dropped, returns are subtracted, and the valuation is rounded once
// on a float total instead of per SKU, half up. The grader runs the report on a second fixture set the agent has not
// seen (four pages, one empty; a SKU counted but never stocked; costs where half-up and half-even differ), so a
// fix tuned to fixtures/expected.txt fails. fixtures/ must be untouched and the unit tests must pass.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, pass, pristine, readTree, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const before = await pristine(import.meta.dir)
const after = await readTree(join(workspace, "fixtures"))
for (const [path, text] of before) {
  if (!path.startsWith("fixtures/")) continue
  if (after.get(path.slice("fixtures/".length)) !== text) fail(`${path} was changed or deleted`)
}
if (after.size !== [...before.keys()].filter((path) => path.startsWith("fixtures/")).length) fail("files were added to fixtures/")

const python = (args: string[]) => run(["python3", "-B", ...args], workspace)
const own = await python(["-m", "inventory.reconcile", "fixtures/"])
if (own.code !== 0) fail(`the report crashes on fixtures/: ${own.output.trim().split("\n").at(-1)}`)
if (own.stdout !== before.get("fixtures/expected.txt")) fail("the report on fixtures/ still differs from fixtures/expected.txt")

const hidden = await mkdtemp(join(tmpdir(), "reconcile-hidden-"))
try {
  const page = (items: object[], next: string | null) => `${JSON.stringify({ items, next }, null, 2)}\n`
  await Promise.all([
    Bun.write(join(hidden, "opening.csv"), "sku,qty\nA-1,10\nB-2,0\nC-3,7\n"),
    Bun.write(join(hidden, "costs.csv"), "sku,unit_cost\nA-1,0.005\nB-2,2.675\nC-3,0.335\nD-4,1.00\n"),
    Bun.write(join(hidden, "counts.csv"), "sku,qty\nA-1,9\nB-2,4\nC-3,8\nD-4,5\nE-5,2\n"),
    Bun.write(join(hidden, "pages/page-1.json"), page([{ sku: "A-1", kind: "receipt", qty: 1 }, { sku: "B-2", kind: "receipt", qty: 3 }], "page-2.json")),
    Bun.write(join(hidden, "pages/page-2.json"), page([], "page-3.json")),
    Bun.write(join(hidden, "pages/page-3.json"), page([{ sku: "C-3", kind: "return", qty: 2 }, { sku: "A-1", kind: "sale", qty: 2 }, { sku: "B-2", kind: "return", qty: 1 }], "page-4.json")),
    Bun.write(join(hidden, "pages/page-4.json"), page([{ sku: "D-4", kind: "receipt", qty: 5 }, { sku: "C-3", kind: "adjustment", qty: -1 }], null)),
  ])
  const want = [
    "SKU        EXPECTED  COUNTED   DIFF",
    "A-1               9        9     +0",
    "B-2               4        4     +0",
    "C-3               8        8     +0",
    "D-4               5        5     +0",
    "E-5               0        2     +2",
    "mismatches: 1",
    // 0.045 -> 0.05, 10.70, 2.68, 5.00: half up per SKU (a float total rounded once gives 18.42).
    "valuation: 18.43",
    "",
  ].join("\n")
  const got = await python(["-m", "inventory.reconcile", hidden])
  if (got.code !== 0) fail(`the report crashes on another day's data: ${got.output.trim().split("\n").at(-1)}`)
  if (got.stdout !== want) {
    const wrong = got.stdout.split("\n").find((line, index) => line !== want.split("\n")[index])
    fail(`the report is wrong on another day's data, first wrong line: ${JSON.stringify(wrong)}`)
  }
} finally {
  await rm(hidden, { recursive: true, force: true })
}
const tests = await python(["-m", "unittest", "discover", "tests"])
if (tests.code !== 0) fail(`the unit tests fail: ${tests.output.trim().split("\n").at(-1)}`)
pass("the report matches expected.txt and is right on another day's data")
