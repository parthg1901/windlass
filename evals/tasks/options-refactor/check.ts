// The new signature works, every caller uses it, and the suite (unchanged) still passes.
import { join } from "node:path"
import { errorLine, fail, importFrom, pass, readTree, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
// src/types.ts may change: a MoneyFormat type next to Customer is a reasonable place for it.
await requireUnchanged(import.meta.dir, workspace, ["tests/billing.test.ts"])
const money = (amount: number, currency: string, locale: string) => new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount)

const { formatMoney } = await importFrom<{ formatMoney: (amount: number, options: { currency: string; locale?: string }) => string }>(workspace, "src/util/money.ts")
const formatted = (() => {
  try {
    return [formatMoney(12.5, { currency: "EUR", locale: "de-DE" }), formatMoney(3, { currency: "USD" }), formatMoney(1200, { locale: "ja-JP", currency: "JPY" })]
  } catch (error) {
    fail(`formatMoney(amount, { currency, locale }) throws: ${String(error).split("\n")[0]}`)
  }
})()
const expected = [money(12.5, "EUR", "de-DE"), money(3, "USD", "en-US"), money(1200, "JPY", "ja-JP")]
if (formatted.join("|") !== expected.join("|")) fail(`formatMoney with an options object returned ${JSON.stringify(formatted)}, expected ${JSON.stringify(expected)}`)

// Every call in src/ passes the amount and one options argument; none still passes a currency or locale string.
// Comments are skipped: a doc comment showing the old signature ("formerly formatMoney(1, "EUR", "de-DE")") is not a call.
const files = await readTree(join(workspace, "src"))
const callers = new Set<string>()
for (const [path, source] of files) {
  for (const args of calls(withoutComments(source), "formatMoney")) {
    if (args.length !== 2) fail(`src/${path} calls formatMoney with ${args.length} arguments: formatMoney(${args.join(", ")})`)
    if (/^["'`]/.test(args[1]!) || /\.(currency|locale)$/.test(args[1]!)) fail(`src/${path} still passes a bare currency or locale: formatMoney(${args.join(", ")})`)
    callers.add(path)
  }
}
// A caller may go through a small helper of its own (say formatFor(customer, amount) in util/money.ts) instead of calling
// formatMoney directly; what it must not do is format money itself, around the function the task is about.
const expectedCallers = ["cart.ts", "email.ts", "invoice.ts", "receipt.ts", "refund.ts", "report.ts"]
const bypass = expectedCallers.filter((path) => !callers.has(path) && /Intl\.NumberFormat|toLocaleString\(/.test(files.get(path) ?? ""))
if (bypass.length > 0) fail(`these files format money themselves instead of using formatMoney: ${bypass.join(", ")}`)

// Hidden inputs through the callers.
const { invoiceTotal } = await importFrom<{ invoiceTotal: (customer: object, items: object[]) => string }>(workspace, "src/invoice.ts")
const { refundNote } = await importFrom<{ refundNote: (customer: object, amount: number, reason: string) => string }>(workspace, "src/refund.ts")
const kenji = { name: "Kenji", email: "k@example.test", locale: "ja-JP", currency: "JPY" }
if (invoiceTotal(kenji, [{ label: "Tea", price: 800, quantity: 3 }]) !== `Total: ${money(2400, "JPY", "ja-JP")}`) fail("invoiceTotal no longer uses the customer's locale and currency")
if (refundNote(kenji, 500, "late") !== `Refund of ${money(500, "JPY", "en-US")} to Kenji: late`) fail("refundNote is no longer in US English")

const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
pass("formatMoney takes an options object and all six callers use it; the suite passes")

/** `source` with block and line comments blanked out (a `//` inside a string is rare enough here to ignore). */
function withoutComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

/** The top-level argument texts of every call `name(...)` in `source` (not its definition). */
function calls(source: string, name: string): string[][] {
  const found: string[][] = []
  for (const match of source.matchAll(new RegExp(`(?<![\\w.])${name}\\(`, "g"))) {
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 12), match.index))) continue
    const args: string[] = []
    let depth = 0
    let current = ""
    for (const char of source.slice(match.index + match[0].length)) {
      if (depth === 0 && char === ")") break
      if ("([{".includes(char)) depth += 1
      if (")]}".includes(char)) depth -= 1
      if (depth === 0 && char === ",") {
        args.push(current.trim())
        current = ""
        continue
      }
      current += char
    }
    if (current.trim() !== "") args.push(current.trim())
    found.push(args)
  }
  return found
}
