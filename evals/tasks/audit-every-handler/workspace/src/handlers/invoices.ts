// Handlers for invoices. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface InvoiceInput {
  readonly number: string
  readonly orderId?: string
  readonly dueDate?: string
}

export interface Invoice extends Row {
  readonly number: string
  readonly orderId: string | null
  readonly dueDate: string | null
  readonly archived: boolean
}

const TABLE = "invoices"

function findInvoice(db: Db, id: string): Invoice {
  const row = db.get<Invoice>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<InvoiceInput>): Partial<InvoiceInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<InvoiceInput>
}

/**
 * Creates a invoice.
 *
 * The number is required and must not be blank. `orderId` is optional and, when given, the order's ID; `dueDate` is optional and, when given, a YYYY-MM-DD date.
 * Returns the stored row, with its new ID.
 */
export function createInvoice(db: Db, input: InvoiceInput): Invoice {
  requireText("number", input.number)
  if (input.orderId !== undefined && (typeof input.orderId !== "string" || input.orderId.trim() === "")) {
    throw new ValidationError("orderId", "must be the order's ID")
  }
  if (input.dueDate !== undefined && (typeof input.dueDate !== "string" || input.dueDate.trim() === "")) {
    throw new ValidationError("dueDate", "must be a YYYY-MM-DD date")
  }
  const clean = normalise(input)
  const row = db.insert<Invoice>(TABLE, {
    number: clean.number!,
    orderId: clean.orderId ?? null,
    dueDate: clean.dueDate ?? null,
    archived: false,
  })
  audit("invoice.create", row.id)
  return row
}

/** One invoice by ID. Throws NotFoundError when there is none. Archived invoices are returned too. */
export function getInvoice(db: Db, id: string): Invoice {
  return findInvoice(db, id)
}

/**
 * Invoices, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listInvoices(db: Db, options: { readonly includeArchived?: boolean } = {}): Invoice[] {
  return db.all<Invoice>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Invoices whose number contains `text`, case-insensitively. Archived ones are left out. */
export function searchInvoices(db: Db, text: string): Invoice[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listInvoices(db).filter((row) => row.number.toLowerCase().includes(needle))
}

/** How many invoices there are, archived ones included. Used by the dashboard tiles. */
export function countInvoices(db: Db): number {
  return db.all<Invoice>(TABLE).length
}

/**
 * Changes some fields of a invoice. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateInvoice(db: Db, id: string, patch: Partial<InvoiceInput>): Invoice {
  const current = findInvoice(db, id)
  if (patch.number !== undefined) requireText("number", patch.number)
  if (patch.orderId !== undefined && (typeof patch.orderId !== "string" || patch.orderId.trim() === "")) {
    throw new ValidationError("orderId", "must be the order's ID")
  }
  if (patch.dueDate !== undefined && (typeof patch.dueDate !== "string" || patch.dueDate.trim() === "")) {
    throw new ValidationError("dueDate", "must be a YYYY-MM-DD date")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Invoice>(TABLE, id, Object.fromEntries(changed))
  audit("invoice.update", id)
  return row
}

/** Renames a invoice: a shortcut for an update of the number alone, used by the inline editor. */
export function renameInvoice(db: Db, id: string, number: string): Invoice {
  requireText("number", number)
  const current = findInvoice(db, id)
  if (current.number === number.trim()) return current
  const row = db.update<Invoice>(TABLE, id, { number: number.trim() })
  audit("invoice.update", id)
  return row
}

/**
 * Archives a invoice: it stays in the database, out of lists and search. Archiving an archived invoice is
 * allowed and changes nothing.
 */
export function archiveInvoice(db: Db, id: string): Invoice {
  const current = findInvoice(db, id)
  if (current.archived) return current
  const row = db.update<Invoice>(TABLE, id, { archived: true })
  return row
}

/** Brings an archived invoice back. Restoring one that is not archived changes nothing. */
export function restoreInvoice(db: Db, id: string): Invoice {
  const current = findInvoice(db, id)
  if (!current.archived) return current
  const row = db.update<Invoice>(TABLE, id, { archived: false })
  audit("invoice.restore", id)
  return row
}

/** Deletes a invoice for good. Throws NotFoundError when there is none. */
export function deleteInvoice(db: Db, id: string): void {
  findInvoice(db, id)
  db.remove(TABLE, id)
  audit("invoice.delete", id)
}

/**
 * Deletes several invoices. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteInvoices(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    audit("invoice.delete", id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every invoice as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * number, orderId, dueDate and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportInvoices(db: Db): string {
  const header = ["id", "number", "orderId", "dueDate", "archived"].join(",")
  const lines = db.all<Invoice>(TABLE).map((row) =>
    [row.id, row.number, row.orderId, row.dueDate, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
