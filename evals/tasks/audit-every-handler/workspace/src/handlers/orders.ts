// Handlers for orders. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface OrderInput {
  readonly reference: string
  readonly customerId?: string
  readonly currency?: string
}

export interface Order extends Row {
  readonly reference: string
  readonly customerId: string | null
  readonly currency: string | null
  readonly archived: boolean
}

const TABLE = "orders"

function findOrder(db: Db, id: string): Order {
  const row = db.get<Order>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<OrderInput>): Partial<OrderInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<OrderInput>
}

/**
 * Creates a order.
 *
 * The reference is required and must not be blank. `customerId` is optional and, when given, the customer's ID; `currency` is optional and, when given, a three-letter currency code.
 * Returns the stored row, with its new ID.
 */
export function createOrder(db: Db, input: OrderInput): Order {
  requireText("reference", input.reference)
  if (input.customerId !== undefined && (typeof input.customerId !== "string" || input.customerId.trim() === "")) {
    throw new ValidationError("customerId", "must be the customer's ID")
  }
  if (input.currency !== undefined && (typeof input.currency !== "string" || input.currency.trim() === "")) {
    throw new ValidationError("currency", "must be a three-letter currency code")
  }
  const clean = normalise(input)
  const row = db.insert<Order>(TABLE, {
    reference: clean.reference!,
    customerId: clean.customerId ?? null,
    currency: clean.currency ?? null,
    archived: false,
  })
  return row
}

/** One order by ID. Throws NotFoundError when there is none. Archived orders are returned too. */
export function getOrder(db: Db, id: string): Order {
  return findOrder(db, id)
}

/**
 * Orders, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listOrders(db: Db, options: { readonly includeArchived?: boolean } = {}): Order[] {
  return db.all<Order>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Orders whose reference contains `text`, case-insensitively. Archived ones are left out. */
export function searchOrders(db: Db, text: string): Order[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listOrders(db).filter((row) => row.reference.toLowerCase().includes(needle))
}

/** How many orders there are, archived ones included. Used by the dashboard tiles. */
export function countOrders(db: Db): number {
  return db.all<Order>(TABLE).length
}

/**
 * Changes some fields of a order. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateOrder(db: Db, id: string, patch: Partial<OrderInput>): Order {
  const current = findOrder(db, id)
  if (patch.reference !== undefined) requireText("reference", patch.reference)
  if (patch.customerId !== undefined && (typeof patch.customerId !== "string" || patch.customerId.trim() === "")) {
    throw new ValidationError("customerId", "must be the customer's ID")
  }
  if (patch.currency !== undefined && (typeof patch.currency !== "string" || patch.currency.trim() === "")) {
    throw new ValidationError("currency", "must be a three-letter currency code")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Order>(TABLE, id, Object.fromEntries(changed))
  audit("order.update", id)
  return row
}

/** Renames a order: a shortcut for an update of the reference alone, used by the inline editor. */
export function renameOrder(db: Db, id: string, reference: string): Order {
  requireText("reference", reference)
  const current = findOrder(db, id)
  if (current.reference === reference.trim()) return current
  const row = db.update<Order>(TABLE, id, { reference: reference.trim() })
  audit("order.update", id)
  return row
}

/**
 * Archives a order: it stays in the database, out of lists and search. Archiving an archived order is
 * allowed and changes nothing.
 */
export function archiveOrder(db: Db, id: string): Order {
  const current = findOrder(db, id)
  if (current.archived) return current
  const row = db.update<Order>(TABLE, id, { archived: true })
  audit("order.archive", id)
  return row
}

/** Brings an archived order back. Restoring one that is not archived changes nothing. */
export function restoreOrder(db: Db, id: string): Order {
  const current = findOrder(db, id)
  if (!current.archived) return current
  const row = db.update<Order>(TABLE, id, { archived: false })
  return row
}

/** Deletes a order for good. Throws NotFoundError when there is none. */
export function deleteOrder(db: Db, id: string): void {
  findOrder(db, id)
  db.remove(TABLE, id)
  audit("order.delete", id)
}

/**
 * Deletes several orders. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteOrders(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    audit("order.delete", id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every order as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * reference, customerId, currency and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportOrders(db: Db): string {
  const header = ["id", "reference", "customerId", "currency", "archived"].join(",")
  const lines = db.all<Order>(TABLE).map((row) =>
    [row.id, row.reference, row.customerId, row.currency, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
