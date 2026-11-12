// Handlers for shipments. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface ShipmentInput {
  readonly tracking: string
  readonly carrier?: string
  readonly weight?: number
}

export interface Shipment extends Row {
  readonly tracking: string
  readonly carrier: string | null
  readonly weight: number | null
  readonly archived: boolean
}

const TABLE = "shipments"

function findShipment(db: Db, id: string): Shipment {
  const row = db.get<Shipment>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<ShipmentInput>): Partial<ShipmentInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<ShipmentInput>
}

/**
 * Creates a shipment.
 *
 * The tracking is required and must not be blank. `carrier` is optional and, when given, a carrier code; `weight` is optional and, when given, a weight in grams.
 * Returns the stored row, with its new ID.
 */
export function createShipment(db: Db, input: ShipmentInput): Shipment {
  requireText("tracking", input.tracking)
  if (input.carrier !== undefined && (typeof input.carrier !== "string" || input.carrier.trim() === "")) {
    throw new ValidationError("carrier", "must be a carrier code")
  }
  if (input.weight !== undefined && (!Number.isInteger(input.weight) || input.weight < 0)) {
    throw new ValidationError("weight", "must be a weight in grams")
  }
  const clean = normalise(input)
  const row = db.insert<Shipment>(TABLE, {
    tracking: clean.tracking!,
    carrier: clean.carrier ?? null,
    weight: clean.weight ?? null,
    archived: false,
  })
  return row
}

/** One shipment by ID. Throws NotFoundError when there is none. Archived shipments are returned too. */
export function getShipment(db: Db, id: string): Shipment {
  return findShipment(db, id)
}

/**
 * Shipments, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listShipments(db: Db, options: { readonly includeArchived?: boolean } = {}): Shipment[] {
  return db.all<Shipment>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Shipments whose tracking contains `text`, case-insensitively. Archived ones are left out. */
export function searchShipments(db: Db, text: string): Shipment[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listShipments(db).filter((row) => row.tracking.toLowerCase().includes(needle))
}

/** How many shipments there are, archived ones included. Used by the dashboard tiles. */
export function countShipments(db: Db): number {
  return db.all<Shipment>(TABLE).length
}

/**
 * Changes some fields of a shipment. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateShipment(db: Db, id: string, patch: Partial<ShipmentInput>): Shipment {
  const current = findShipment(db, id)
  if (patch.tracking !== undefined) requireText("tracking", patch.tracking)
  if (patch.carrier !== undefined && (typeof patch.carrier !== "string" || patch.carrier.trim() === "")) {
    throw new ValidationError("carrier", "must be a carrier code")
  }
  if (patch.weight !== undefined && (!Number.isInteger(patch.weight) || patch.weight < 0)) {
    throw new ValidationError("weight", "must be a weight in grams")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Shipment>(TABLE, id, Object.fromEntries(changed))
  audit("shipment.update", id)
  return row
}

/** Renames a shipment: a shortcut for an update of the tracking alone, used by the inline editor. */
export function renameShipment(db: Db, id: string, tracking: string): Shipment {
  requireText("tracking", tracking)
  const current = findShipment(db, id)
  if (current.tracking === tracking.trim()) return current
  const row = db.update<Shipment>(TABLE, id, { tracking: tracking.trim() })
  audit("shipment.update", id)
  return row
}

/**
 * Archives a shipment: it stays in the database, out of lists and search. Archiving an archived shipment is
 * allowed and changes nothing.
 */
export function archiveShipment(db: Db, id: string): Shipment {
  const current = findShipment(db, id)
  if (current.archived) return current
  const row = db.update<Shipment>(TABLE, id, { archived: true })
  audit("shipment.archive", id)
  return row
}

/** Brings an archived shipment back. Restoring one that is not archived changes nothing. */
export function restoreShipment(db: Db, id: string): Shipment {
  const current = findShipment(db, id)
  if (!current.archived) return current
  const row = db.update<Shipment>(TABLE, id, { archived: false })
  return row
}

/** Deletes a shipment for good. Throws NotFoundError when there is none. */
export function deleteShipment(db: Db, id: string): void {
  findShipment(db, id)
  db.remove(TABLE, id)
  audit("shipment.delete", id)
}

/**
 * Deletes several shipments. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteShipments(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every shipment as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * tracking, carrier, weight and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportShipments(db: Db): string {
  const header = ["id", "tracking", "carrier", "weight", "archived"].join(",")
  const lines = db.all<Shipment>(TABLE).map((row) =>
    [row.id, row.tracking, row.carrier, row.weight, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
