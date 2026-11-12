// Reference: rename everywhere; the store maps a legacy userId to accountId when loading.
import { join } from "node:path"

const dir = process.argv[2]!
for (const file of ["templates/invoice-email.txt", "src/types.ts", "src/invoices.ts", "src/report.ts", "src/reminders.ts", "src/invoices.test.ts"]) {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  await Bun.write(path, text.replaceAll("userId", "accountId").replaceAll("totalByUser", "totalByAccount").replaceAll("byUser", "byAccount").replaceAll("usr_", "acc_"))
}
await Bun.write(
  join(dir, "src/store.ts"),
  `import type { Invoice } from "./types.ts"

/** Invoices written before the rename carry userId. */
type Stored = Omit<Invoice, "accountId"> & { readonly accountId?: string; readonly userId?: string }

export async function loadInvoices(path: string): Promise<Invoice[]> {
  const raw = (await Bun.file(path).json()) as Stored[]
  return raw.map(({ userId, accountId, ...invoice }) => ({ ...invoice, accountId: (accountId ?? userId)!, lines: [...invoice.lines] }))
}

export async function saveInvoices(path: string, invoices: readonly Invoice[]): Promise<void> {
  await Bun.write(path, \`\${JSON.stringify(invoices, null, 2)}\\n\`)
}
`,
)
