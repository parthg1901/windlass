// Graders must accept every reasonable way of doing what the prompt asks, and still reject plausible wrong answers.
// Each case starts from the untouched workspace or the reference solution, changes it the way a different (correct or
// wrong) agent might, and grades it. The "accepts" cases are ones an earlier, stricter grader rejected.
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdtemp, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { run } from "./grader.ts"
import { memoryTaskSource } from "./memory-tasks/source.ts"
import { applySolution, grade, prepareWorkspace } from "./run-check.ts"
import { E2E_TIMEOUT_MS } from "../packages/core/src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

interface Case {
  readonly task: string
  readonly name: string
  /** Start from the reference solution (default) or the untouched workspace. */
  readonly from?: "solution" | "pristine"
  readonly change: (dir: string) => Promise<unknown>
  readonly pass: boolean
}

const dirs: string[] = []
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

const read = (dir: string, path: string) => Bun.file(join(dir, path)).text()
const write = (dir: string, path: string, text: string) => Bun.write(join(dir, path), text)
async function replace(dir: string, path: string, from: string | RegExp, to: string) {
  const text = await read(dir, path)
  const next = text.replace(from, to)
  if (next === text) throw new Error(`test bug: ${String(from)} not found in ${path}`)
  await write(dir, path, next)
}

const CASES: Case[] = [
  // fix-failing-test: "the tests are right" forbids weakening them, not adding to them.
  {
    task: "fix-failing-test",
    name: "accepts a regression test added to the existing test file",
    change: async (dir) =>
      write(dir, "src/duration.test.ts", `${await read(dir, "src/duration.test.ts")}\ntest("minutes wrap at the hour", () => {\n  expect(formatDuration(3_660_000)).toBe("1h 1m")\n})\n`),
    pass: true,
  },
  {
    task: "fix-failing-test",
    name: "rejects a test file edited to expect the bug",
    from: "pristine",
    change: (dir) => replace(dir, "src/duration.test.ts", '"1h 2m 3s"', '"1h 62m 3s"'),
    pass: false,
  },

  // project-checks: the prompt does not mention the tests or the harness config.
  {
    task: "project-checks",
    name: "accepts new test cases and a changed harness config",
    change: async (dir) => {
      await write(dir, "src/discount.test.ts", `${await read(dir, "src/discount.test.ts")}\ntest("just above the threshold", () => {\n  expect(bulkDiscount(100.01)).toBe(10)\n})\n`)
      await write(dir, ".windlass/config.json", '{\n  "checks": [{ "name": "tests", "command": "bun test", "timeoutSeconds": 180 }]\n}\n')
    },
    pass: true,
  },
  {
    task: "project-checks",
    name: "rejects the one-line fix with the invoice test that catches it deleted",
    from: "pristine",
    change: async (dir) => {
      await replace(dir, "src/discount.ts", "subtotal > BULK_THRESHOLD", "subtotal >= BULK_THRESHOLD")
      await replace(dir, "src/invoice.test.ts", /test\("an order of exactly 100[\s\S]*?\n\}\)\n/, "")
    },
    pass: false,
  },

  // noisy-test-suite: "don't change the tests" covers tests/run.ts and the test script, not all of package.json.
  {
    task: "noisy-test-suite",
    name: "accepts an unrelated package.json change",
    change: (dir) => replace(dir, "package.json", '"private": true,', '"private": true,\n  "description": "Date helpers",'),
    pass: true,
  },
  {
    task: "noisy-test-suite",
    name: "rejects a changed test script",
    change: (dir) => replace(dir, "package.json", '"test": "bun tests/run.ts"', '"test": "bun tests/run.ts | tail -1"'),
    pass: false,
  },

  // crashing-script: the summary lines must be right; an extra notice line is not a wrong summary.
  {
    task: "crashing-script",
    name: "accepts a fix that also prints a notice about orders without tags",
    change: (dir) =>
      replace(dir, "report.ts", "console.log(`orders: ${orders.length}`)", "console.log(`note: ${orders.filter((order) => !order.tags).length} order(s) have no tags`)\nconsole.log(`orders: ${orders.length}`)"),
    pass: true,
  },
  {
    task: "crashing-script",
    name: "rejects a fix that drops orders without tags",
    from: "pristine",
    change: (dir) => replace(dir, "report.ts", "await Bun.file(path).json()", "(await Bun.file(path).json()).filter((order: Order) => Array.isArray(order.tags))"),
    pass: false,
  },

  // follow-up-change: an apostrophe may be dropped or become a hyphen.
  {
    task: "follow-up-change",
    name: "accepts a slugify that drops punctuation instead of turning it into hyphens",
    from: "pristine",
    change: async (dir) =>
      write(
        dir,
        "src/text.ts",
        `${await read(dir, "src/text.ts")}
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\\s-]/g, "")
    .trim()
    .replace(/[\\s-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
`,
      ),
    pass: true,
  },
  {
    task: "follow-up-change",
    name: "rejects a slugify that only did the first message",
    from: "pristine",
    change: async (dir) => write(dir, "src/text.ts", `${await read(dir, "src/text.ts")}\nexport const slugify = (title: string) => title.trim().toLowerCase().split(/\\s+/).join("-")\n`),
    pass: false,
  },

  // options-refactor: types may live in types.ts, comments may mention the old call, a caller may use a helper.
  {
    task: "options-refactor",
    name: "accepts MoneyFormat in types.ts, the old signature in a comment and a caller going through a helper",
    change: async (dir) => {
      await write(dir, "src/types.ts", `${await read(dir, "src/types.ts")}\nexport interface MoneyFormat {\n  readonly currency: string\n  readonly locale?: string\n}\n`)
      await write(
        dir,
        "src/util/money.ts",
        `${await read(dir, "src/util/money.ts")}\n// Was formatMoney(amount, "USD", "en-US") before the options object.\n/** The shop's own currency. */\nexport const formatShop = (amount: number) => formatMoney(amount, { currency: "USD" })\n`,
      )
      await replace(dir, "src/cart.ts", 'import { formatMoney } from "./util/money.ts"', 'import { formatShop } from "./util/money.ts"')
      await replace(dir, "src/cart.ts", 'formatMoney(total, { currency: "USD" })', "formatShop(total)")
    },
    pass: true,
  },
  {
    task: "options-refactor",
    name: "rejects a caller that formats money itself",
    change: async (dir) => {
      await replace(dir, "src/cart.ts", 'import { formatMoney } from "./util/money.ts"\n', "")
      await replace(dir, "src/cart.ts", 'formatMoney(total, { currency: "USD" })', 'new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(total)')
    },
    pass: false,
  },
  {
    task: "options-refactor",
    name: "rejects a caller left on the old order of arguments",
    change: (dir) => replace(dir, "src/receipt.ts", "formatMoney(paid, { currency: customer.currency, locale: customer.locale })", "formatMoney(paid, customer.currency)"),
    pass: false,
  },

  // rename-function: judge what store.ts exports, not how it is written; a changelog may name the old function.
  {
    task: "rename-function",
    name: "accepts an arrow-function export and a CHANGELOG naming the old function",
    change: async (dir) => {
      await replace(dir, "src/store.ts", /export function getUserById\(id: number\): User \| undefined \{\n  return (.*)\n\}/, "export const getUserById = (id: number): User | undefined => $1")
      await write(dir, "CHANGELOG.md", "# Changelog\n\n- Renamed `getUsr` to `getUserById`.\n")
    },
    pass: true,
  },
  {
    task: "rename-function",
    name: "rejects keeping getUsr as an alias",
    change: async (dir) => write(dir, "src/store.ts", `${await read(dir, "src/store.ts")}\n/** @deprecated */\nexport const getUsr = getUserById\n`),
    pass: false,
  },
  {
    task: "rename-function",
    name: "rejects the old name kept in a new code file",
    change: async (dir) => write(dir, "src/compat.ts", 'export { getUserById as getUsr } from "./store.ts"\n'),
    pass: false,
  },

  // add-feature: rounding and repeated discounts are left open by the prompt; tests may use it().
  {
    task: "add-feature",
    name: "accepts floor rounding, compounding repeated discounts and it()-style tests",
    from: "pristine",
    change: async (dir) => {
      await replace(dir, "src/cart.ts", "private readonly items: LineItem[] = []", "private readonly items: LineItem[] = []\n  private factor = 1")
      await replace(
        dir,
        "src/cart.ts",
        "  total() {\n    return this.subtotal()\n  }",
        "  applyDiscount(percent: number) {\n    if (percent < 0 || percent > 100 || Number.isNaN(percent)) throw new RangeError(`bad discount ${percent}`)\n    this.factor *= 1 - percent / 100\n  }\n\n  total() {\n    return Math.floor(this.subtotal() * this.factor)\n  }",
      )
      await write(dir, "src/cart.test.ts", (await read(dir, "src/cart.test.ts")).replaceAll("test(", "it(").replace("{ expect, test }", "{ expect, it }"))
      await write(dir, "src/cart.discount.spec.ts", 'import { expect, it } from "bun:test"\nimport { Cart } from "./cart.ts"\n\nit("applyDiscount", () => {\n  const cart = new Cart().add("a", 1000)\n  cart.applyDiscount(10)\n  expect(cart.total()).toBe(900)\n})\n')
    },
    pass: true,
  },
  {
    task: "add-feature",
    name: "rejects a discount fixed at the total when it was applied",
    from: "pristine",
    change: async (dir) => {
      await replace(dir, "src/cart.ts", "private readonly items: LineItem[] = []", "private readonly items: LineItem[] = []\n  private off = 0")
      await replace(
        dir,
        "src/cart.ts",
        "  total() {\n    return this.subtotal()\n  }",
        "  applyDiscount(percent: number) {\n    if (percent < 0 || percent > 100) throw new RangeError(`bad discount ${percent}`)\n    this.off = Math.round((this.subtotal() * percent) / 100)\n  }\n\n  total() {\n    return this.subtotal() - this.off\n  }",
      )
      await write(dir, "src/discount.test.ts", 'import { expect, test } from "bun:test"\nimport { Cart } from "./cart.ts"\n\ntest("applyDiscount", () => {\n  const cart = new Cart().add("a", 1000)\n  cart.applyDiscount(10)\n  expect(cart.total()).toBe(900)\n})\n')
    },
    pass: false,
  },

  // answer-question: the grader is right; 4000 is the longest wait of the default schedule, which the app overrides.
  { task: "answer-question", name: "accepts the number with its unit", from: "pristine", change: (dir) => write(dir, "answer.txt", "3600 ms\n"), pass: true },
  { task: "answer-question", name: "rejects the default schedule's 4000", from: "pristine", change: (dir) => write(dir, "answer.txt", "4000\n"), pass: false },
  { task: "answer-question", name: "rejects the request timeout added on (13600)", from: "pristine", change: (dir) => write(dir, "answer.txt", "13600\n"), pass: false },

  // retry-after-error: moving the stale lock aside is as good as deleting it; migrating the wrong database is not.
  {
    task: "retry-after-error",
    name: "accepts a stale lock moved aside instead of deleted",
    from: "pristine",
    change: async (dir) => {
      await rename(join(dir, "db/dev.lock"), join(dir, "db/dev.lock.stale"))
      await run(["bun", "migrate.ts", "--env", "dev"], dir)
    },
    pass: true,
  },
  {
    task: "retry-after-error",
    name: "rejects migrating test as well",
    change: (dir) => run(["bun", "migrate.ts", "--env", "test"], dir),
    pass: false,
  },
  { task: "retry-after-error", name: "rejects stopping to ask with the lock in place", from: "pristine", change: async () => {}, pass: false },

  // agents-md-rule: the task exists to test the nested rule, which must still fail when broken.
  {
    task: "agents-md-rule",
    name: "rejects a route that builds its Response directly",
    change: (dir) => replace(dir, "packages/api/src/routes/health.route.ts", 'return json({ status: "ok" })', 'return Response.json({ status: "ok" })'),
    pass: false,
  },
]

// Sequential on purpose, like graders.test.ts: graders run real commands.
describe("graders judge the outcome, not one way of reaching it", () => {
  for (const item of CASES) {
    test(`${item.task}: ${item.name}`, async () => {
      const { dir } = await prepareWorkspace(item.task)
      dirs.push(dir)
      if ((item.from ?? "solution") === "solution") await applySolution(item.task, dir)
      await item.change(dir)
      const result = await grade(item.task, dir)
      expect({ pass: result.pass, message: result.message }).toEqual({ pass: item.pass, message: expect.stringMatching(item.pass ? /^ok:/ : /^fail:/) })
    }, 300_000)
  }
})

// The tasks added for the second baseline (evals/README.md, "The harder tasks").
const MORE_CASES: Case[] = [
  // rename-across-files: renaming the reminder's `to` too is more than asked, not wrong; a type that keeps userId or
  // a loader that drops old records is wrong.
  {
    task: "rename-across-files",
    name: "accepts the reminder's recipient field renamed to accountId as well",
    change: async (dir) => {
      await replace(dir, "src/reminders.ts", "readonly to: string", "readonly accountId: string")
      await replace(dir, "src/reminders.ts", ".map(([to, list]) => ({ to,", ".map(([accountId, list]) => ({ accountId,")
      await replace(dir, "src/reminders.ts", "a.to.localeCompare(b.to)", "a.accountId.localeCompare(b.accountId)")
      await write(dir, "src/invoices.test.ts", (await read(dir, "src/invoices.test.ts")).replaceAll("{ to: ", "{ accountId: "))
    },
    pass: true,
  },
  { task: "rename-across-files", name: "rejects an Invoice type that keeps an optional userId", change: (dir) => replace(dir, "src/types.ts", "  readonly accountId: string\n", "  readonly accountId: string\n  /** @deprecated */\n  readonly userId?: string\n"), pass: false },
  { task: "rename-across-files", name: "rejects a store that no longer reads old invoices", change: (dir) => replace(dir, "src/store.ts", "accountId: (accountId ?? userId)!", "accountId: accountId!"), pass: false },

  // test-blames-wrong-file: any quote-aware split is fine; editing the statement or fixing only the separators is not.
  {
    task: "test-blames-wrong-file",
    name: "accepts a regular-expression split that strips the quotes",
    from: "pristine",
    change: async (dir) => {
      await replace(dir, "src/csv.ts", 'return line.split(",").map((field) => field.trim())', 'return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((field) => field.trim().replace(/^"(.*)"$/, "$1"))')
      await replace(dir, "src/csv.ts", "Number.parseFloat(text)", 'Number(text.replace(/,/g, ""))')
    },
    pass: true,
  },
  { task: "test-blames-wrong-file", name: "rejects only dropping the thousands separators", from: "pristine", change: (dir) => replace(dir, "src/csv.ts", "Number.parseFloat(text)", 'Number.parseFloat(text.replaceAll(",", ""))'), pass: false },
  { task: "test-blames-wrong-file", name: "rejects an edited statement file", from: "pristine", change: (dir) => write(dir, "fixtures/january.csv", "date,description,amount\n2026-01-03,Office chairs,1234.50\n2026-01-04,Coffee beans,99.00\n2026-01-05,Paper,12.50\n2026-01-09,Client payment,1000.00\n2026-01-12,Bank fee,-59.60\n"), pass: false },

  // not-a-bug: the explanation may give the number alone; adding a regression test is a change the user ruled out.
  { task: "not-a-bug", name: "accepts an explanation that only gives the result", from: "pristine", change: (dir) => write(dir, "ANSWER.md", "I ran it: parseDuration(\"1h30m\") returns 5400 here, so our code is fine.\n"), pass: true },
  { task: "not-a-bug", name: "rejects a regression test added next to the explanation", change: async (dir) => write(dir, "src/duration.test.ts", `${await read(dir, "src/duration.test.ts")}\ntest("1h30m", () => expect(parseDuration("1h30m")).toBe(5400))\n`), pass: false },

  // run-to-find-out: lines may carry the reason; the default profile's list is the likely wrong answer.
  {
    task: "run-to-find-out",
    name: "accepts each id followed by its reason",
    change: async (dir) => write(dir, "rejected.txt", (await read(dir, "rejected.txt")).trim().split("\n").map((id) => `${id}: rejected by --profile ci`).join("\n")),
    pass: true,
  },
  {
    task: "run-to-find-out",
    name: "rejects the list the default profile gives",
    change: async (dir) => {
      const script = 'import json, sys\nfrom pathlib import Path\nsys.path.insert(0, "tools")\nfrom validate import Invalid, load_profile, validate_record\np = load_profile("default")\nfor f in sorted(Path("data").glob("*.json")):\n    r = json.loads(f.read_text())\n    try:\n        validate_record(r, p)\n    except Invalid:\n        print(r["id"])\n'
      await write(dir, "rejected.txt", (await run(["python3", "-B", "-c", script], dir)).stdout)
    },
    pass: false,
  },
  {
    task: "run-to-find-out",
    name: "rejects data/late checked under the ci profile instead of ci-late",
    change: async (dir) => {
      const script = 'import json, sys\nfrom pathlib import Path\nsys.path.insert(0, "tools")\nfrom validate import Invalid, load_profile, validate_record\np = load_profile("ci")\nfor d in ["data", "data/late"]:\n    for f in sorted(Path(d).glob("*.json")):\n        r = json.loads(f.read_text())\n        try:\n            validate_record(r, p)\n        except Invalid:\n            print(r["id"])\n'
      await write(dir, "rejected.txt", (await run(["python3", "-B", "-c", script], dir)).stdout)
    },
    pass: false,
  },

  // audit-every-handler: auditing deleted rows after the loop is fine; auditing an update that changed nothing is not.
  {
    task: "audit-every-handler",
    name: "accepts a bulk delete that audits the deleted rows after its loop",
    change: async (dir) => {
      await replace(dir, "src/handlers/customers.ts", '    audit("customer.delete", id)\n    deleted.push(id)\n  }\n  return deleted', '    deleted.push(id)\n  }\n  for (const id of deleted) audit("customer.delete", id)\n  return deleted')
    },
    pass: true,
  },
  {
    task: "audit-every-handler",
    name: "rejects an update audited before its no-change check",
    change: async (dir) => {
      await replace(dir, "src/handlers/orders.ts", "  const clean = normalise(patch)\n", '  audit("order.update", id)\n  const clean = normalise(patch)\n')
      await replace(dir, "src/handlers/orders.ts", '  const row = db.update<Order>(TABLE, id, Object.fromEntries(changed))\n  audit("order.update", id)\n', "  const row = db.update<Order>(TABLE, id, Object.fromEntries(changed))\n")
    },
    pass: false,
  },
  { task: "audit-every-handler", name: "rejects a missed handler", change: (dir) => replace(dir, "src/handlers/tickets.ts", '  db.remove(TABLE, id)\n  audit("ticket.delete", id)\n}', "  db.remove(TABLE, id)\n}"), pass: false },

  // api-report-check: the report may be updated by hand if it is right; leaving it stale, or bending the check, is not.
  {
    task: "api-report-check",
    name: "accepts a different median and a hand-updated report",
    from: "pristine",
    change: async (dir) => {
      await write(dir, "src/stats.ts", `${await read(dir, "src/stats.ts")}\nexport const median = (values: readonly number[]): number => {\n  const s = values.slice().sort((a, b) => a - b)\n  const h = s.length >> 1\n  return s.length & 1 ? s[h]! : (s[h - 1]! + s[h]!) / 2\n}\n`)
      await replace(dir, ".api/report.txt", "function mean(1)\n", "function mean(1)\nfunction median(1)\n")
    },
    pass: true,
  },
  { task: "api-report-check", name: "rejects median without updating the report", change: (dir) => replace(dir, ".api/report.txt", "function median(1)\n", ""), pass: false },
  {
    task: "api-report-check",
    name: "rejects a check script edited to pass instead of the report",
    change: async (dir) => {
      await replace(dir, ".api/report.txt", "function median(1)\n", "")
      await replace(dir, "scripts/api-check.ts", "if (report === current) {", "if (true) {")
    },
    pass: false,
  },

  // follow-a-skill: any 0005 name and wording; editing an applied migration or the snapshot by hand is not.
  {
    task: "follow-a-skill",
    name: "accepts another name and wording",
    change: async (dir) => {
      await rename(join(dir, "migrations/0005_add_users_nickname.sql"), join(dir, "migrations/0005_users_nickname.sql"))
      await replace(dir, "docs/schema-changes.md", "- 0005: users have an optional nickname.", "- 0005: Added an optional `nickname` column to users")
    },
    pass: true,
  },
  {
    task: "follow-a-skill",
    name: "rejects the column added to an existing migration",
    from: "pristine",
    change: async (dir) => {
      await replace(dir, "migrations/0003_add_users_display_name.sql", "ALTER TABLE users ADD COLUMN display_name TEXT;\n", "ALTER TABLE users ADD COLUMN display_name TEXT;\nALTER TABLE users ADD COLUMN nickname TEXT;\n")
      await run(["bun", "scripts/schema-dump.ts"], dir)
    },
    pass: false,
  },
  { task: "follow-a-skill", name: "rejects a snapshot that was not regenerated", change: (dir) => replace(dir, "schema.sql", ", nickname TEXT", ""), pass: false },

  // nested-agents-md: a TypeError is a fine way to throw in the server; a throwing edge-agent parser is not.
  { task: "nested-agents-md", name: "accepts a TypeError in the server", change: (dir) => replace(dir, "packages/server/src/config.ts", "throw new RangeError(", "throw new TypeError("), pass: true },
  { task: "nested-agents-md", name: "rejects an edge-agent parsePort that throws", change: (dir) => replace(dir, "packages/edge-agent/src/config.ts", "return err(`port ${JSON.stringify(text)} is not 1 to 65535`)", "throw new RangeError(`port ${JSON.stringify(text)}`)"), pass: false },

  // generated-file-trap: the check may sit after the count; editing the generated file by hand is the trap.
  {
    task: "generated-file-trap",
    name: "accepts a limit checked after counting",
    from: "pristine",
    change: async (dir) => {
      const errors = JSON.parse(await read(dir, "errors.json")) as unknown[]
      errors.splice(4, 0, { status: 429, message: "Too many uploads, try again in a minute.", code: "RATE_LIMITED" })
      await write(dir, "errors.json", JSON.stringify(errors))
      await run(["bun", "scripts/gen-errors.ts"], dir)
      await replace(dir, "src/handlers/upload.ts", "  uploadsInWindow.set(request.user, (uploadsInWindow.get(request.user) ?? 0) + 1)\n", '  const count = (uploadsInWindow.get(request.user) ?? 0) + 1\n  uploadsInWindow.set(request.user, count)\n  if (count > 20) return apiError("RATE_LIMITED")\n')
    },
    pass: true,
  },
  {
    task: "generated-file-trap",
    name: "rejects the generated file edited by hand, errors.json too",
    from: "pristine",
    change: async (dir) => {
      const errors = JSON.parse(await read(dir, "errors.json")) as unknown[]
      errors.push({ code: "RATE_LIMITED", status: 429, message: "Too many uploads, try again in a minute." })
      await write(dir, "errors.json", JSON.stringify(errors, null, 2))
      await replace(dir, "src/generated/errors.ts", '| "INTERNAL"', '| "RATE_LIMITED" | "INTERNAL"')
      await replace(dir, "src/generated/errors.ts", "  INTERNAL:", '  RATE_LIMITED: { status: 429, message: "Too many uploads, try again in a minute." },\n  INTERNAL:')
      await replace(dir, "src/handlers/upload.ts", "  uploadsInWindow.set(", '  if ((uploadsInWindow.get(request.user) ?? 0) >= 20) return apiError("RATE_LIMITED")\n  uploadsInWindow.set(')
    },
    pass: false,
  },

  // read-chart-image: formatting is free; the second-highest bar is the likely misreading.
  { task: "read-chart-image", name: "accepts the file rewritten with other formatting", change: async (dir) => write(dir, "deploy/services.json", JSON.stringify(JSON.parse(await read(dir, "deploy/services.json")))), pass: true },
  { task: "read-chart-image", name: "rejects scaling up the second-highest service", change: async (dir) => write(dir, "deploy/services.json", (await read(dir, "deploy/services.json")).replace('"name": "storefront",\n      "dashboardLabel": "WEB",\n      "replicas": 4,\n      "cpu": "500m",\n      "scaleUp": false', '"name": "storefront",\n      "dashboardLabel": "WEB",\n      "replicas": 4,\n      "cpu": "500m",\n      "scaleUp": true')), pass: false },

  // due-dates-feature: tests may live anywhere; a date parser that rolls 2026-02-30 over to March is wrong.
  {
    task: "due-dates-feature",
    name: "accepts the tests in another directory",
    change: async (dir) => {
      await write(dir, "test/due.test.ts", (await read(dir, "src/due.test.ts")).replace('from "./cli.ts"', 'from "../src/cli.ts"'))
      await Bun.file(join(dir, "src/due.test.ts")).delete()
    },
    pass: true,
  },
  { task: "due-dates-feature", name: "accepts --overdue in the order the tasks were added", change: (dir) => replace(dir, "src/commands.ts", 'if (args.includes("--overdue")) tasks = tasks.filter(', 'if (args.includes("--overdue")) tasks = all.filter('), pass: true },
  { task: "due-dates-feature", name: "rejects a date check that lets impossible dates roll over", change: (dir) => replace(dir, "src/format.ts", "return date.toISOString().slice(0, 10) === text", "return !Number.isNaN(date.getTime())"), pass: false },

  // reconcile-several-bugs: integer cents work as well as Decimal; two of three fixes, or an edited expectation, do not.
  {
    task: "reconcile-several-bugs",
    name: "accepts valuation in integer arithmetic",
    change: (dir) =>
      write(
        dir,
        "inventory/money.py",
        'from fractions import Fraction\n\n\ndef valuation(on_hand, costs):\n    total = 0\n    for sku, qty in on_hand.items():\n        exact = Fraction(costs[sku]) * qty * 100\n        total += int(exact + Fraction(1, 2)) if exact >= 0 else -int(-exact + Fraction(1, 2))\n    return f"{total // 100}.{total % 100:02d}"\n',
      ),
    pass: true,
  },
  { task: "reconcile-several-bugs", name: "rejects keeping the float total", change: (dir) => write(dir, "inventory/money.py", 'def valuation(on_hand, costs):\n    total = sum(qty * float(costs[sku]) for sku, qty in on_hand.items())\n    return f"{round(total, 2):.2f}"\n'), pass: false },
  { task: "reconcile-several-bugs", name: "rejects an edited expected.txt", from: "pristine", change: async (dir) => write(dir, "fixtures/expected.txt", (await run(["python3", "-B", "-m", "inventory.reconcile", "fixtures/"], dir)).stdout), pass: false },
]

describe("graders of the added tasks judge the outcome", () => {
  for (const item of MORE_CASES) {
    test(`${item.task}: ${item.name}`, async () => {
      const { dir } = await prepareWorkspace(item.task)
      dirs.push(dir)
      if ((item.from ?? "solution") === "solution") await applySolution(item.task, dir)
      await item.change(dir)
      const result = await grade(item.task, dir)
      expect({ pass: result.pass, message: result.message }).toEqual({ pass: item.pass, message: expect.stringMatching(item.pass ? /^ok:/ : /^fail:/) })
    }, 300_000)
  }
})

// The memory A/B tasks (evals/memory-tasks/): the convention is the point, so breaking it must fail; other ways of
// keeping it must pass.
const MEMORY_CASES: Case[] = [
  { task: "changelog-fragments", name: "rejects an entry written into CHANGELOG.md", from: "pristine", change: async (dir) => { await replace(dir, "src/paginate.ts", "items.length - 1)", "items.length)"); await replace(dir, "CHANGELOG.md", "# Changelog\n\n", "# Changelog\n\n## Unreleased\n\n- `paginate` returns the last item on the last page. (#482)\n\n") }, pass: false },
  { task: "changelog-fragments", name: "accepts another fix and a feature-typed fragment", from: "pristine", change: async (dir) => { await replace(dir, "src/paginate.ts", "const end = Math.min(start + size, items.length - 1)", "const end = start + size"); await write(dir, ".changes/482.feature.md", "paginate keeps the last item of a short last page\n") }, pass: true },
  { task: "amounts-in-cents", name: "rejects a fee in dollars", from: "pristine", change: (dir) => replace(dir, "src/pricing.ts", "export function orderTotal", "export function shippingFee(order: Order): number {\n  return order.subtotal < 50 ? 4.99 : 0\n}\n\nexport function orderTotal"), pass: false },
  { task: "amounts-in-cents", name: "accepts taxed shipping", change: (dir) => replace(dir, "src/pricing.ts", "return taxFor(order.subtotal - discount(order, coupon), order.region)", "return taxFor(order.subtotal - discount(order, coupon) + shippingFee(order), order.region)"), pass: true },
  { task: "amounts-in-cents", name: "accepts the fee in a module of its own, with named constants", from: "pristine", change: async (dir) => { await write(dir, "src/shipping.ts", 'import type { Order } from "./types.ts"\n\nexport const FREE_SHIPPING_CENTS = 50_00\nexport const SHIPPING_CENTS = 4_99\n\nexport const shippingFee = (order: Pick<Order, "subtotal">) => (order.subtotal >= FREE_SHIPPING_CENTS ? 0 : SHIPPING_CENTS)\n'); await replace(dir, "src/pricing.ts", 'import { taxFor } from "./tax.ts"', 'import { shippingFee } from "./shipping.ts"\nimport { taxFor } from "./tax.ts"\n\nexport { shippingFee }'); await replace(dir, "src/pricing.ts", "+ tax(order, coupon)\n}", "+ tax(order, coupon) + shippingFee(order)\n}") }, pass: true },
  { task: "amounts-in-cents", name: "rejects a fee in cents with the threshold left in dollars", change: (dir) => replace(dir, "src/pricing.ts", "const FREE_SHIPPING_FROM = 5000", "const FREE_SHIPPING_FROM = 50"), pass: false },
  { task: "error-codes", name: "rejects a plain Error like the rest of users.ts", from: "pristine", change: (dir) => replace(dir, "src/users.ts", "  if (users.some(", '  if (!input.email.includes("@")) throw new Error("email is not valid")\n  if (users.some('), pass: false },
  { task: "error-codes", name: "rejects a reused code", from: "pristine", change: async (dir) => { await replace(dir, "src/users.ts", "export interface User", 'import { AppError } from "./errors/app-error.ts"\n\nexport interface User'); await replace(dir, "src/users.ts", "  if (users.some(", '  if (!input.email.includes("@")) throw new AppError("E4002")\n  if (users.some(') }, pass: false },
  { task: "error-codes", name: "accepts a code later in the range without a detail", change: async (dir) => { for (const file of ["src/errors/codes.ts", "docs/errors.md", "src/users.ts"]) await write(dir, file, (await read(dir, file)).replaceAll("E4011", "E4015")); await replace(dir, "src/users.ts", 'new AppError("E4015", input.email)', 'new AppError("E4015")') }, pass: true },
  { task: "error-codes", name: "rejects reusing E4010, the code for a missing email", from: "pristine", change: (dir) => replace(dir, "src/users.ts", "  if (users.some(", '  if (!input.email.includes("@")) throw new AppError("E4010", input.email)\n  if (users.some('), pass: false },
  { task: "error-codes", name: "rejects a new code registered in codes.ts but missing from the docs table", change: (dir) => replace(dir, "docs/errors.md", "| E4011 | email address is not valid |\n", ""), pass: false },
  { task: "error-codes", name: "accepts a stricter email check and a wider table row", change: async (dir) => { await replace(dir, "src/users.ts", '!input.email.includes("@")', "!/^[^@\\s]+@[^@\\s]+$/.test(input.email.trim())"); await replace(dir, "docs/errors.md", "| E4011 | email address is not valid |", "|  E4011  | email address is not valid (no @, or more than one) |") }, pass: true },
  { task: "prefixed-ids", name: "rejects reaction ids from randomUUID", change: (dir) => replace(dir, "src/reactions.ts", 'newId("rxn")', "crypto.randomUUID()"), pass: false },
  { task: "prefixed-ids", name: "accepts another prefix and a refused repeat", change: async (dir) => { await replace(dir, "src/ids.ts", 'rxn: "reaction"', 'rea: "comment_reaction"'); await replace(dir, "src/reactions.ts", 'newId("rxn")', 'newId("rea")'); await replace(dir, "src/reactions.ts", "if (existing) return existing", 'if (existing) throw new Error("already reacted")') }, pass: true },
  { task: "prefixed-ids", name: "accepts reactions kept in a map of the shared store", change: async (dir) => { await replace(dir, "src/store.ts", "  readonly polls: Map<string, Poll>\n", "  readonly polls: Map<string, Poll>\n  readonly reactions: Map<string, { id: string; commentId: string; emoji: string; userId: string }>\n"); await replace(dir, "src/store.ts", "polls: new Map() }", "polls: new Map(), reactions: new Map() }"); await write(dir, "src/reactions.ts", 'import { newId } from "./ids.ts"\nimport type { Store } from "./store.ts"\n\nexport function addReaction(store: Store, commentId: string, emoji: string, userId: string) {\n  for (const item of store.reactions.values()) if (item.commentId === commentId && item.emoji === emoji && item.userId === userId) return item\n  const reaction = { id: newId("rxn"), commentId, emoji, userId }\n  store.reactions.set(reaction.id, reaction)\n  return reaction\n}\n\nexport const reactionsFor = (store: Store, commentId: string) => [...store.reactions.values()].filter((item) => item.commentId === commentId)\n') }, pass: true },
  { task: "prefixed-ids", name: "rejects reaction ids made with an unregistered prefix", change: async (dir) => { await replace(dir, "src/ids.ts", '  rxn: "reaction",\n', ""); await replace(dir, "src/ids.ts", "if (!(prefix in PREFIXES)) throw", "if (false) throw") }, pass: false },
  { task: "injected-clock", name: "rejects an expiry check on the system clock", from: "pristine", change: (dir) => replace(dir, "src/resets.ts", "  resets.delete(token)\n  return reset.userId", '  resets.delete(token)\n  if (Date.now() - reset.createdAt > 30 * 60 * 1000) throw new Error("expired")\n  return reset.userId'), pass: false },
  { task: "injected-clock", name: "accepts an expiry time stored at creation and null for an expired link", from: "pristine", change: async (dir) => { await write(dir, "src/resets.ts", 'import { MINUTE, now } from "./lib/runtime.ts"\n\nexport interface Reset {\n  readonly token: string\n  readonly userId: string\n  readonly createdAt: number\n  readonly expiresAt: number\n}\n\nconst resets = new Map<string, Reset>()\n\nexport function createReset(userId: string): Reset {\n  const createdAt = now()\n  const reset = { token: crypto.randomUUID(), userId, createdAt, expiresAt: createdAt + 30 * MINUTE }\n  resets.set(reset.token, reset)\n  return reset\n}\n\nexport function useReset(token: string): string | null {\n  const reset = resets.get(token)\n  if (!reset) throw new Error("this reset link is not valid")\n  resets.delete(token)\n  return now() <= reset.expiresAt ? reset.userId : null\n}\n') }, pass: true },
  { task: "injected-clock", name: "accepts the project clock in the check while createdAt still uses Date.now()", from: "pristine", change: async (dir) => { await replace(dir, "src/resets.ts", "export interface Reset", 'import { now } from "./lib/runtime.ts"\n\nexport interface Reset'); await replace(dir, "src/resets.ts", "  resets.delete(token)\n  return reset.userId", '  resets.delete(token)\n  if (now() - reset.createdAt >= 30 * 60_000) throw new Error("expired")\n  return reset.userId') }, pass: true },
  { task: "env-registry", name: "rejects reading process.env in digest.ts without declaring the variable", from: "pristine", change: (dir) => replace(dir, "src/digest.ts", "const BATCH_SIZE = 50", "const BATCH_SIZE = Number(process.env.DIGEST_BATCH_SIZE ?? 50)"), pass: false },
  { task: "env-registry", name: "rejects a declared variable that the batch size does not follow", from: "pristine", change: (dir) => replace(dir, "src/config/settings.ts", "} as const satisfies", '  DIGEST_BATCH_SIZE: { default: "50", description: "digest batch size" },\n} as const satisfies'), pass: false },
  { task: "env-registry", name: "accepts the value read once at load, parsed with parseInt, and the docs regenerated", from: "pristine", change: async (dir) => { await replace(dir, "src/config/settings.ts", "} as const satisfies", '  DIGEST_BATCH_SIZE: { default: "50", description: "how many digests per relay call" },\n} as const satisfies'); await replace(dir, "src/digest.ts", 'import { digestMail, type Mail } from "./mailer.ts"', 'import { env } from "./config/settings.ts"\nimport { digestMail, type Mail } from "./mailer.ts"'); await replace(dir, "src/digest.ts", "const BATCH_SIZE = 50", 'const BATCH_SIZE = Number.parseInt(env("DIGEST_BATCH_SIZE"), 10)'); await run(["bun", "scripts/env-docs.ts"], dir) }, pass: true },
  { task: "stale-timestamps", name: "rejects unix seconds, as the out-of-date note says", from: "pristine", change: async (dir) => { await replace(dir, "src/api/shipments.ts", 'import { iso } from "./time.ts"', 'import { iso, seconds } from "./time.ts"'); await replace(dir, "src/api/shipments.ts", "    deliveredAt:", "    pickedUpAt: shipment.pickedUpAt === null ? null : seconds(shipment.pickedUpAt),\n    deliveredAt:") }, pass: false },
  { task: "stale-timestamps", name: "accepts toISOString and leaving the field out before pick-up", from: "pristine", change: (dir) => replace(dir, "src/api/shipments.ts", "    deliveredAt:", "    ...(shipment.pickedUpAt ? { pickedUpAt: shipment.pickedUpAt.toISOString() } : {}),\n    deliveredAt:"), pass: true },
  { task: "stale-timestamps", name: "rejects the Date object itself", from: "pristine", change: (dir) => replace(dir, "src/api/shipments.ts", "    deliveredAt:", "    pickedUpAt: shipment.pickedUpAt,\n    deliveredAt:"), pass: false },
  { task: "unrelated-notes", name: "accepts a split and join instead of a trailing replace", from: "pristine", change: (dir) => replace(dir, "src/slug.ts", '.replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-/, "")', '.split(/[^a-z0-9]+/)\n    .filter((word) => word !== "")\n    .join("-")'), pass: true },
  { task: "unrelated-notes", name: "rejects stripping only a trailing exclamation mark", from: "pristine", change: (dir) => replace(dir, "src/slug.ts", "  return title\n", '  return title\n    .replace(/!+$/, "")\n'), pass: false },
  { task: "i18n-strings", name: "rejects a hard-coded message", from: "pristine", change: (dir) => replace(dir, "src/cart.ts", '  const lines = ["Your cart"]\n', '  const lines = ["Your cart"]\n  if (items.length === 0) return [...lines, "Your cart is empty."]\n'), pass: false },
  { task: "i18n-strings", name: "rejects a key added to en.json while the code still hard-codes the text", change: (dir) => replace(dir, "src/cart.ts", 't("cart.empty")', '"Your cart is empty."'), pass: false },
  { task: "i18n-strings", name: "accepts another key and wording, and a German text as well", from: "pristine", change: async (dir) => { await replace(dir, "src/i18n/en.json", '  "checkout.heading"', '  "cart.nothing-here": "There is nothing in your cart yet.",\n  "checkout.heading"'); await replace(dir, "src/i18n/de.json", '  "checkout.heading"', '  "cart.nothing-here": "Ihr Warenkorb ist noch leer.",\n  "checkout.heading"'); await replace(dir, "src/cart.ts", "import { displayMoney }", 'import { t } from "./i18n/t.ts"\nimport { displayMoney }'); await replace(dir, "src/cart.ts", '  lines.push(`Total:', '  if (items.length === 0) {\n    lines.push(t("cart.nothing-here"))\n    return lines\n  }\n  lines.push(`Total:') }, pass: true },
  { task: "commit-convention", name: "rejects a commit message in another style", from: "pristine", change: async (dir) => { await replace(dir, "src/upload.ts", "exeeds", "exceeds"); await run(["git", "commit", "-qam", "Fix typo in upload error message (#77)"], dir) }, pass: false },
  { task: "commit-convention", name: "accepts a body paragraph before the trailer", from: "pristine", change: async (dir) => { await replace(dir, "src/upload.ts", "exeeds", "exceeds"); await run(["git", "commit", "-qa", "-m", "upload: fix a typo in the size error", "-m", "The message said exeeds.", "-m", "Refs: #77"], dir) }, pass: true },
]

describe("graders of the memory tasks judge the outcome", () => {
  for (const item of MEMORY_CASES) {
    test(`${item.task}: ${item.name}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "wl-eval-memory-"))
      dirs.push(dir)
      await memoryTaskSource.prepare(item.task, dir)
      if ((item.from ?? "solution") === "solution") await memoryTaskSource.solve(item.task, dir)
      await item.change(dir)
      const result = await memoryTaskSource.grade(item.task, dir)
      expect({ pass: result.pass, message: result.message }).toEqual({ pass: item.pass, message: expect.stringMatching(item.pass ? /^ok:/ : /^fail:/) })
    }, 300_000)
  }
})
