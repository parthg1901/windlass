// Handlers for tickets. Each takes the database first; the HTTP layer maps routes onto them.
// Keep validation here rather than in the routes: the batch importer calls these handlers directly.
import { audit } from "../audit.ts"
import type { Db, Row } from "../db.ts"
import { NotFoundError, ValidationError, requireText } from "../errors.ts"

export interface TicketInput {
  readonly subject: string
  readonly priority?: string
  readonly assignee?: string
}

export interface Ticket extends Row {
  readonly subject: string
  readonly priority: string | null
  readonly assignee: string | null
  readonly archived: boolean
}

const TABLE = "tickets"

function findTicket(db: Db, id: string): Ticket {
  const row = db.get<Ticket>(TABLE, id)
  if (row === undefined) throw new NotFoundError(TABLE, id)
  return row
}

function normalise(input: Partial<TicketInput>): Partial<TicketInput> {
  // Trim text fields; leave numbers and missing fields alone. Callers have validated types already.
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) result[key] = typeof value === "string" ? value.trim() : value
  return result as Partial<TicketInput>
}

/**
 * Creates a ticket.
 *
 * The subject is required and must not be blank. `priority` is optional and, when given, low, normal or high; `assignee` is optional and, when given, a staff handle.
 * Returns the stored row, with its new ID.
 */
export function createTicket(db: Db, input: TicketInput): Ticket {
  requireText("subject", input.subject)
  if (input.priority !== undefined && (typeof input.priority !== "string" || input.priority.trim() === "")) {
    throw new ValidationError("priority", "must be low, normal or high")
  }
  if (input.assignee !== undefined && (typeof input.assignee !== "string" || input.assignee.trim() === "")) {
    throw new ValidationError("assignee", "must be a staff handle")
  }
  const clean = normalise(input)
  const row = db.insert<Ticket>(TABLE, {
    subject: clean.subject!,
    priority: clean.priority ?? null,
    assignee: clean.assignee ?? null,
    archived: false,
  })
  audit("ticket.create", row.id)
  return row
}

/** One ticket by ID. Throws NotFoundError when there is none. Archived tickets are returned too. */
export function getTicket(db: Db, id: string): Ticket {
  return findTicket(db, id)
}

/**
 * Tickets, oldest first. Archived ones are left out unless `includeArchived` is set.
 * The admin screen pages through this; the page size is applied by the HTTP layer.
 */
export function listTickets(db: Db, options: { readonly includeArchived?: boolean } = {}): Ticket[] {
  return db.all<Ticket>(TABLE).filter((row) => options.includeArchived === true || !row.archived)
}

/** Tickets whose subject contains `text`, case-insensitively. Archived ones are left out. */
export function searchTickets(db: Db, text: string): Ticket[] {
  const needle = text.trim().toLowerCase()
  if (needle === "") return []
  return listTickets(db).filter((row) => row.subject.toLowerCase().includes(needle))
}

/** How many tickets there are, archived ones included. Used by the dashboard tiles. */
export function countTickets(db: Db): number {
  return db.all<Ticket>(TABLE).length
}

/**
 * Changes some fields of a ticket. Fields not given keep their values.
 *
 * When every given field already has the given value nothing is written and the row is returned as it is.
 */
export function updateTicket(db: Db, id: string, patch: Partial<TicketInput>): Ticket {
  const current = findTicket(db, id)
  if (patch.subject !== undefined) requireText("subject", patch.subject)
  if (patch.priority !== undefined && (typeof patch.priority !== "string" || patch.priority.trim() === "")) {
    throw new ValidationError("priority", "must be low, normal or high")
  }
  if (patch.assignee !== undefined && (typeof patch.assignee !== "string" || patch.assignee.trim() === "")) {
    throw new ValidationError("assignee", "must be a staff handle")
  }
  const clean = normalise(patch)
  const changed = Object.entries(clean).filter(([key, value]) => (current as unknown as Record<string, unknown>)[key] !== value)
  if (changed.length === 0) return current
  const row = db.update<Ticket>(TABLE, id, Object.fromEntries(changed))
  audit("ticket.update", id)
  return row
}

/** Renames a ticket: a shortcut for an update of the subject alone, used by the inline editor. */
export function renameTicket(db: Db, id: string, subject: string): Ticket {
  requireText("subject", subject)
  const current = findTicket(db, id)
  if (current.subject === subject.trim()) return current
  const row = db.update<Ticket>(TABLE, id, { subject: subject.trim() })
  return row
}

/**
 * Archives a ticket: it stays in the database, out of lists and search. Archiving an archived ticket is
 * allowed and changes nothing.
 */
export function archiveTicket(db: Db, id: string): Ticket {
  const current = findTicket(db, id)
  if (current.archived) return current
  const row = db.update<Ticket>(TABLE, id, { archived: true })
  audit("ticket.archive", id)
  return row
}

/** Brings an archived ticket back. Restoring one that is not archived changes nothing. */
export function restoreTicket(db: Db, id: string): Ticket {
  const current = findTicket(db, id)
  if (!current.archived) return current
  const row = db.update<Ticket>(TABLE, id, { archived: false })
  audit("ticket.restore", id)
  return row
}

/** Deletes a ticket for good. Throws NotFoundError when there is none. */
export function deleteTicket(db: Db, id: string): void {
  findTicket(db, id)
  db.remove(TABLE, id)
}

/**
 * Deletes several tickets. IDs that do not exist are skipped (the importer retries batches), and the IDs
 * actually deleted are returned in the order given.
 */
export function bulkDeleteTickets(db: Db, ids: readonly string[]): string[] {
  const deleted: string[] = []
  for (const id of ids) {
    if (db.get(TABLE, id) === undefined) continue
    db.remove(TABLE, id)
    audit("ticket.delete", id)
    deleted.push(id)
  }
  return deleted
}

/**
 * Every ticket as CSV, for the finance team's spreadsheet: a header line, then one line per row with the ID,
 * subject, priority, assignee and whether it is archived. Commas in text are replaced by spaces.
 */
export function exportTickets(db: Db): string {
  const header = ["id", "subject", "priority", "assignee", "archived"].join(",")
  const lines = db.all<Ticket>(TABLE).map((row) =>
    [row.id, row.subject, row.priority, row.assignee, row.archived].map((value) => String(value ?? "").replaceAll(",", " ")).join(","),
  )
  return [header, ...lines].join("\n")
}
