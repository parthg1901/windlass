import { fail, importFrom, errorLine, pass, readTree, run, workspaceArg } from "../../grader.ts"

interface CartLike {
  add(sku: string, priceCents: number, quantity?: number): CartLike
  applyDiscount(percent: number): unknown
  subtotal(): number
  total(): number
}

const workspace = workspaceArg()
const { Cart } = await importFrom<{ Cart: new () => CartLike }>(workspace, "src/cart.ts")
const make = () => new Cart().add("lamp", 2000).add("bulb", 500, 4)
if (typeof make().applyDiscount !== "function") fail("Cart has no applyDiscount method")

const discounted = make()
discounted.applyDiscount(25)
if (discounted.total() !== 3000) fail(`25% off a 4000 cent cart gave total() ${discounted.total()}, expected 3000`)
if (discounted.subtotal() !== 4000) fail(`subtotal() changed to ${discounted.subtotal()} after a discount`)
const full = make()
full.applyDiscount(100)
if (full.total() !== 0) fail(`100% off gave total() ${full.total()}, expected 0`)
const none = make()
none.applyDiscount(0)
if (none.total() !== 4000) fail(`0% off gave total() ${none.total()}, expected 4000`)
const later = make()
later.applyDiscount(50)
later.add("shade", 1000)
if (later.total() !== 2500) fail(`a discount should apply to items added afterwards too (got ${later.total()}, expected 2500)`)
// Only what the prompt asks for: below 0 or above 100. NaN is neither, so it is not graded.
for (const bad of [-1, 101, -0.5, 100.5]) {
  let error: unknown
  try {
    make().applyDiscount(bad)
  } catch (caught) {
    error = caught
  }
  if (!(error instanceof RangeError)) fail(`applyDiscount(${bad}) should throw a RangeError`)
}

const files = await readTree(workspace)
const tested = [...files].some(([path, text]) => /\.(test|spec)\.ts$/.test(path) && text.includes("applyDiscount"))
if (!tested) fail("no test file exercises applyDiscount")
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
const original = (files.get("src/cart.test.ts") ?? "").match(/\btest\(/g)?.length ?? 0
if (original < 3) fail("the original cart tests were removed")
pass("applyDiscount works, is validated and is tested")
