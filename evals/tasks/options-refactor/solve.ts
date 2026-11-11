import { join } from "node:path"

const src = join(process.argv[2]!, "src")
await Bun.write(
  join(src, "util/money.ts"),
  `export interface MoneyFormat {
  readonly currency: string
  /** Default "en-US". */
  readonly locale?: string
}

/** Formats an amount of money, e.g. formatMoney(12.5, { currency: "EUR", locale: "de-DE" }) -> "12,50 €". */
export function formatMoney(amount: number, options: MoneyFormat): string {
  return new Intl.NumberFormat(options.locale ?? "en-US", { style: "currency", currency: options.currency }).format(amount)
}
`,
)
for (const file of ["invoice.ts", "receipt.ts", "refund.ts", "report.ts", "email.ts", "cart.ts"]) {
  const path = join(src, file)
  const text = (await Bun.file(path).text())
    .replace(/formatMoney\(([^,()]+(?:\([^()]*\))?[^,()]*), ([^,()]+), "en-US"\)/g, "formatMoney($1, { currency: $2 })")
    .replace(/formatMoney\(([^,()]+(?:\([^()]*\))?[^,()]*), ([^,()]+), ([^,()]+)\)/g, "formatMoney($1, { currency: $2, locale: $3 })")
  await Bun.write(path, text)
}
