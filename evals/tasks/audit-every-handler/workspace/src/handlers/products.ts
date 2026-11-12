// Handlers for products. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface ProductInput {
  readonly sku: string
  readonly price?: number
  readonly category?: string
}

export interface Product extends Row {
  readonly sku: string
  readonly price: number | null
  readonly category: string | null
  readonly archived: boolean
}

const TABLE = "products"

function findProduct(db: Db, id: string): Product {
  const row = db.get<Product>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<ProductInput>): Partial<ProductInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<ProductInput>
}

/**
 * Creates a product.
 *
 * The sku is required and must not be blank. `price` is optional and, when given, a price in cents; `category` is optional and, when given, a category slug.
 * Returns the stored row, with its new ID.
 */
export function createProduct(db: Db, input: ProductInput): Product {
  requireText("sku", input.sku)
  if (input.price !== undefined && (!Number.isInteger(input.price) || input.price < 0)) {
    throw new ValidationError("price", "must be a price in cents")
  }
  if (input.category !== undefined && (typeof input.category !== "string" || input.category.trim() === "")) {
    throw new ValidationError("category", "must be a category slug")
  }
  const clean = normalise(input)
  const row = db.insert<Product>(TABLE, {
    sku: clean.sku!,
    price: clean.price ?? null,
    category: clean.category ?? null,
    archived: false,
  })
  audit("product.create", row.id)
  return row
}

/** One product by ID. Throws NotFoundError when there is none. Archived products are returned too. */
export function getProduct(db: Db, id: string): Product {
  return findProduct(db, id)
}

/**
 * Products, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listProducts(db: Db, options: { readonly includeArchived?: boolean } = {}): Product[] {
  return db.all<Product>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Products whose sku contains `text`, case-insensitively. Archived ones are left out. */
export function searchProducts(db: Db, text: string): Product[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listProducts(db).filter((row) => row.sku.toLowerCase().includes(needle))
}

/** How many products there are, archived ones included. Used by the dashboard tiles. */
export function countProducts(db: Db): number {
  return db.all<Product>(TABLE).length
}

/**
 * Changes some fields of a product. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateProduct(db: Db, id: string, patch: Partial<ProductInput>): Product {
  const current = findProduct(db, id)
  if (patch.sku !== undefined) requireText("sku", patch.sku)
  if (patch.price !== undefined && (!Number.isInteger(patch.price) || patch.price < 0)) {
    throw new ValidationError("price", "must be a price in cents")
  }
  if (patch.category !== undefined && (typeof patch.category !== "string" || patch.category.trim() === "")) {
    throw new ValidationError("category", "must be a category slug")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Product>(TABLE, id, Object.fromEntries(changed))
  return row
}

/** Renames a product: a shortcut for an update of the sku alone, used by the inline editor. */
export function renameProduct(db: Db, id: string, sku: string): Product {
  requireText("sku", sku)
  const current = findProduct(db, id)
  if (current.sku === sku.trim()) return current
  const row = db.update<Product>(TABLE, id, { sku: sku.trim() })
  return row
}

/**
 * Archives a product: it stays in the database, out of lists and search. Archiving an archived product is
 * allowed and changes nothing.
 */
export function archiveProduct(db: Db, id: string): Product {
  const current = findProduct(db, id)
  if (current.archived) return current
  const row = db.update<Product>(TABLE, id, { archived: true })
  audit("product.archive", id)
  return row
}

/** Brings an archived product back. Restoring one that is not archived changes nothing. */
export function restoreProduct(db: Db, id: string): Product {
  const current = findProduct(db, id)
  if (!current.archived) return current
  const row = db.update<Product>(TABLE, id, { archived: false })
  audit("product.restore", id)
  return row
}

/** Deletes a product for good. Throws NotFoundError when there is none. */
export function deleteProduct(db: Db, id: string): void {
  findProduct(db, id)
  db.remove(TABLE, id)
}

/**
 * Deletes several products. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteProducts(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    audit("product.delete", id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every product as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * sku, price, category and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportProducts(db: Db): string {
  const header = ["id", "sku", "price", "category", "archived"].join(",")
  const lines = db.all<Product>(TABLE).map((row) =>
    [row.id, row.sku, row.price, row.category, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
