// Every piece of text a customer sees comes from t() with a key in src/i18n/en.json (src/i18n/README.md, which the
// README points to; cart.ts and orders.ts use it; the free-shipping line in cart.ts is a leftover). Graded on the
// outcome: an empty cart's lines are the heading and a message saying it is empty, without a total; the message
// comes from en.json (the grader changes the English text it uses and the page follows); a cart with items is
// unchanged. The key's name and the wording are free.
import { join } from "node:path"
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/cart.test.ts"])
type Lines = (items: readonly { name: string; quantity: number; unitPrice: number }[]) => string[]
const { cartLines } = await importFrom<{ cartLines: Lines }>(workspace, "src/cart.ts")
const empty = cartLines([])
if (empty.some((line) => /\$0\.00|total/i.test(line))) fail(`an empty cart still shows a total: ${JSON.stringify(empty)}`)
if (empty[0] !== "Your cart") fail(`an empty cart does not start with its heading: ${JSON.stringify(empty)}`)
const messages = empty.slice(1)
if (!messages.some((line) => /empty|nothing|no items/i.test(line))) fail(`an empty cart shows no message saying it is empty: ${JSON.stringify(empty)}`)
const full = cartLines([{ name: "Mug", quantity: 1, unitPrice: 6000 }])
if (JSON.stringify(full) !== JSON.stringify(["Your cart", "1 × Mug", "Total: $60.00"])) fail(`a cart with items changed: ${JSON.stringify(full)}`)

// The message must come from en.json: every English text that appears in the message lines is changed, and a fresh
// process must show the changed text. The file is put back afterwards.
const path = join(workspace, "src/i18n/en.json")
const original = await Bun.file(path).text()
const english = JSON.parse(original) as Record<string, string>
const used = Object.keys(english).filter((key) => {
  const fixed = english[key]!.split(/\{\w+\}/).map((part) => part.trim()).filter((part) => part.length >= 4)
  return key !== "cart.heading" && fixed.length > 0 && fixed.every((part) => messages.some((line) => line.includes(part)))
})
if (used.length === 0) fail(`the empty-cart message ${JSON.stringify(messages)} is not a text from src/i18n/en.json, so it is never translated`)
let lines: string[] = []
try {
  await Bun.write(path, JSON.stringify(Object.fromEntries(Object.entries(english).map(([key, text]) => [key, used.includes(key) ? `QQ ${key} QQ` : text])), null, 2))
  const child = Bun.spawnSync(["bun", join(import.meta.dir, "probe.ts"), workspace], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
  if (child.exitCode !== 0) fail(`the cart page failed with en.json changed: ${child.stderr.toString().trim().split("\n").at(-1)}`)
  lines = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!)
} finally {
  await Bun.write(path, original)
}
if (!used.some((key) => lines.some((line) => line.includes(`QQ ${key} QQ`)))) fail(`the empty-cart message does not follow src/i18n/en.json: with its English text changed the page shows ${JSON.stringify(lines)}`)
pass("an empty cart shows a message from en.json instead of the total")
