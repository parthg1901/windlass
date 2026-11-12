import { join } from "node:path"

const dir = process.argv[2]!
const en = join(dir, "src/i18n/en.json")
await Bun.write(en, (await Bun.file(en).text()).replace('  "cart.heading": "Your cart",\n', '  "cart.heading": "Your cart",\n  "cart.empty": "Your cart is empty.",\n'))
const cart = join(dir, "src/cart.ts")
await Bun.write(cart, (await Bun.file(cart).text()).replace('import { displayMoney }', 'import { t } from "./i18n/t.ts"\nimport { displayMoney }').replace('  const lines = ["Your cart"]\n', '  const lines = ["Your cart"]\n  if (items.length === 0) return [...lines, t("cart.empty")]\n'))
