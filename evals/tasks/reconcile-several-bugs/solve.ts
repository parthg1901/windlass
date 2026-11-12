// Reference: read every page (the last one too), count returns as stock coming back, and value each SKU with
// decimal arithmetic rounded half up before summing.
import { join } from "node:path"

const dir = process.argv[2]!
const edit = async (file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit(
  "inventory/api.py",
  '        page = self._page("page-1.json")\n        while page["next"]:\n            items.extend(page["items"])\n            page = self._page(page["next"])\n        return items',
  '        name = "page-1.json"\n        while name:\n            page = self._page(name)\n            items.extend(page["items"])\n            name = page["next"]\n        return items',
)
await edit("inventory/ledger.py", '"return": -1', '"return": 1')
await Bun.write(
  join(dir, "inventory/money.py"),
  `"""Stock valuation."""

from decimal import ROUND_HALF_UP, Decimal

CENT = Decimal("0.01")


def valuation(on_hand: dict[str, int], costs: dict[str, str]) -> str:
    """The value of the stock, as a string with two decimals: each SKU rounded half up to the cent, then summed."""
    total = Decimal(0)
    for sku, qty in on_hand.items():
        total += (Decimal(qty) * Decimal(costs[sku])).quantize(CENT, rounding=ROUND_HALF_UP)
    return f"{total:.2f}"
`,
)
