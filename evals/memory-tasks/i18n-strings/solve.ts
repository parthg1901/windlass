import { join } from "node:path"

const dir = process.argv[2]!
const en = join(dir, "src/i18n/en.json")
await Bun.write(en, (await Bun.file(en).text()).replace('  "cart.heading": "Your cart",\n', '  "cart.heading": "Your cart",\n  "cart.empty": "Your cart is empty.",\n'))
const cart = join(dir, "src/cart.ts")
await Bun.write(cart, (await Bun.file(cart).text()).replace('  const lines = [t("cart.heading")]\n', '  const lines = [t("cart.heading")]\n  if (items.length === 0) return [...lines, t("cart.empty")]\n'))
