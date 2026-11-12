import { join } from "node:path"
import type { Invoice } from "./types.ts"

const TEMPLATE = join(import.meta.dir, "../templates/invoice-email.txt")

/** The invoice email: `{{field}}` in the template is replaced by that field of the invoice. */
export async function renderInvoiceEmail(invoice: Invoice): Promise<string> {
  const template = await Bun.file(TEMPLATE).text()
  return template.replace(/\{\{(\w+)\}\}/g, (_, field: string) => String((invoice as unknown as Record<string, unknown>)[field] ?? ""))
}
