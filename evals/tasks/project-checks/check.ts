// The fix the user asks for touches discount.ts; invoice.ts repeats the threshold, so the obvious one-line fix leaves
// its test failing. The project's declared check (bun test) catches that, whether the agent or the harness runs it.
import { errorLine, fail, importFrom, pass, requireOriginalTestsPass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
// The prompt does not forbid touching the tests: adding cases is fine, but the original ones must still pass.
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/discount.test.ts", "src/invoice.test.ts"])
const { bulkDiscount } = await importFrom<{ bulkDiscount: (subtotal: number) => number }>(workspace, "src/discount.ts")
for (const [subtotal, expected] of [[100, 10], [99.99, 0], [100.01, 10], [180, 18], [0, 0]] as const) {
  if (bulkDiscount(subtotal) !== expected) fail(`bulkDiscount(${subtotal}) returned ${bulkDiscount(subtotal)}, expected ${expected}`)
}
const { invoice } = await importFrom<{ invoice: (items: { label: string; amount: number }[]) => { lines: { label: string; amount: number }[]; total: number } }>(workspace, "src/invoice.ts")
const exact = invoice([{ label: "A", amount: 70 }, { label: "B", amount: 30 }])
if (exact.total !== 90 || !exact.lines.some((line) => line.amount === -10)) fail(`an invoice of exactly 100 has total ${exact.total} and lines ${JSON.stringify(exact.lines)}`)
const below = invoice([{ label: "A", amount: 99.5 }])
if (below.lines.length !== 1 || below.total !== 99.5) fail("an invoice below 100 now shows a discount")
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`the project's check (bun test) fails: ${errorLine(tests.output)}`)
pass("the threshold is inclusive everywhere and the project's check passes")
