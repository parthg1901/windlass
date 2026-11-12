// Graders must accept every reasonable way of doing what the prompt asks, and still reject plausible wrong answers.
// Each case starts from the untouched workspace or the reference solution, changes it the way a different (correct or
// wrong) agent might, and grades it. The "accepts" cases are ones an earlier, stricter grader rejected.
import { afterAll, describe, expect, test } from "bun:test"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { run } from "./grader.ts"
import { applySolution, grade, prepareWorkspace } from "./run-check.ts"

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
      await write(dir, ".light-harness/config.json", '{\n  "checks": [{ "name": "tests", "command": "bun test", "timeoutSeconds": 180 }]\n}\n')
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
