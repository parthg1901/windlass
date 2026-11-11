import { join } from "node:path"

const dir = process.argv[2]!
const cart = join(dir, "src/cart.ts")
const source = await Bun.file(cart).text()
await Bun.write(
  cart,
  source
    .replace("private readonly items: LineItem[] = []", "private readonly items: LineItem[] = []\n  private discountPercent = 0")
    .replace(
      "  total() {\n    return this.subtotal()\n  }",
      `  applyDiscount(percent: number) {
    if (!(percent >= 0 && percent <= 100)) throw new RangeError(\`invalid discount: \${percent}\`)
    this.discountPercent = percent
    return this
  }

  total() {
    return Math.round((this.subtotal() * (100 - this.discountPercent)) / 100)
  }`,
    ),
)
await Bun.write(
  join(dir, "src/discount.test.ts"),
  `import { expect, test } from "bun:test"
import { Cart } from "./cart.ts"

test("discount reduces the total but not the subtotal", () => {
  const cart = new Cart().add("lamp", 2000).applyDiscount(15)
  expect(cart.total()).toBe(1700)
  expect(cart.subtotal()).toBe(2000)
})

test("discount outside 0-100 throws", () => {
  expect(() => new Cart().applyDiscount(-1)).toThrow(RangeError)
  expect(() => new Cart().applyDiscount(101)).toThrow(RangeError)
})
`,
)
