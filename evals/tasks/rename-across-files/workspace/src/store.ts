import type { Invoice } from "./types.ts"

export async function loadInvoices(path: string): Promise<Invoice[]> {
  const raw = (await Bun.file(path).json()) as Invoice[]
  return raw.map((invoice) => ({ ...invoice, lines: [...invoice.lines] }))
}

export async function saveInvoices(path: string, invoices: readonly Invoice[]): Promise<void> {
  await Bun.write(path, `${JSON.stringify(invoices, null, 2)}\n`)
}
