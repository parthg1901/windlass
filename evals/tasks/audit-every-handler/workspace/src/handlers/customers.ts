// Handlers for customers. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface CustomerInput {
  readonly name: string
  readonly email?: string
  readonly country?: string
}

export interface Customer extends Row {
  readonly name: string
  readonly email: string | null
  readonly country: string | null
  readonly archived: boolean
}

const TABLE = "customers"

function findCustomer(db: Db, id: string): Customer {
  const row = db.get<Customer>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<CustomerInput>): Partial<CustomerInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<CustomerInput>
}

/**
 * Creates a customer.
 *
 * The name is required and must not be blank. `email` is optional and, when given, an email address; `country` is optional and, when given, a two-letter country code.
 * Returns the stored row, with its new ID.
 */
export function createCustomer(db: Db, input: CustomerInput): Customer {
  requireText("name", input.name)
  if (input.email !== undefined && (typeof input.email !== "string" || input.email.trim() === "")) {
    throw new ValidationError("email", "must be an email address")
  }
  if (input.country !== undefined && (typeof input.country !== "string" || input.country.trim() === "")) {
    throw new ValidationError("country", "must be a two-letter country code")
  }
  const clean = normalise(input)
  const row = db.insert<Customer>(TABLE, {
    name: clean.name!,
    email: clean.email ?? null,
    country: clean.country ?? null,
    archived: false,
  })
  audit("customer.create", row.id)
  return row
}

/** One customer by ID. Throws NotFoundError when there is none. Archived customers are returned too. */
export function getCustomer(db: Db, id: string): Customer {
  return findCustomer(db, id)
}

/**
 * Customers, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listCustomers(db: Db, options: { readonly includeArchived?: boolean } = {}): Customer[] {
  return db.all<Customer>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Customers whose name contains `text`, case-insensitively. Archived ones are left out. */
export function searchCustomers(db: Db, text: string): Customer[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listCustomers(db).filter((row) => row.name.toLowerCase().includes(needle))
}

/** How many customers there are, archived ones included. Used by the dashboard tiles. */
export function countCustomers(db: Db): number {
  return db.all<Customer>(TABLE).length
}

/**
 * Changes some fields of a customer. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateCustomer(db: Db, id: string, patch: Partial<CustomerInput>): Customer {
  const current = findCustomer(db, id)
  if (patch.name !== undefined) requireText("name", patch.name)
  if (patch.email !== undefined && (typeof patch.email !== "string" || patch.email.trim() === "")) {
    throw new ValidationError("email", "must be an email address")
  }
  if (patch.country !== undefined && (typeof patch.country !== "string" || patch.country.trim() === "")) {
    throw new ValidationError("country", "must be a two-letter country code")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Customer>(TABLE, id, Object.fromEntries(changed))
  return row
}

/** Renames a customer: a shortcut for an update of the name alone, used by the inline editor. */
export function renameCustomer(db: Db, id: string, name: string): Customer {
  requireText("name", name)
  const current = findCustomer(db, id)
  if (current.name === name.trim()) return current
  const row = db.update<Customer>(TABLE, id, { name: name.trim() })
  audit("customer.update", id)
  return row
}

/**
 * Archives a customer: it stays in the database, out of lists and search. Archiving an archived customer is
 * allowed and changes nothing.
 */
export function archiveCustomer(db: Db, id: string): Customer {
  const current = findCustomer(db, id)
  if (current.archived) return current
  const row = db.update<Customer>(TABLE, id, { archived: true })
  return row
}

/** Brings an archived customer back. Restoring one that is not archived changes nothing. */
export function restoreCustomer(db: Db, id: string): Customer {
  const current = findCustomer(db, id)
  if (!current.archived) return current
  const row = db.update<Customer>(TABLE, id, { archived: false })
  audit("customer.restore", id)
  return row
}

/** Deletes a customer for good. Throws NotFoundError when there is none. */
export function deleteCustomer(db: Db, id: string): void {
  findCustomer(db, id)
  db.remove(TABLE, id)
  audit("customer.delete", id)
}

/**
 * Deletes several customers. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteCustomers(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every customer as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * name, email, country and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportCustomers(db: Db): string {
  const header = ["id", "name", "email", "country", "archived"].join(",")
  const lines = db.all<Customer>(TABLE).map((row) =>
    [row.id, row.name, row.email, row.country, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
