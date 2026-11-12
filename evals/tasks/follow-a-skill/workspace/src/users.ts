import type { Database } from "bun:sqlite"

/** A row of the users table, as SQLite returns it. */
export interface UserRow {
  readonly id: number
  readonly email: string
  readonly created_at: string
  readonly display_name: string | null
}

/** A user as the API returns it. */
export interface ApiUser {
  readonly id: number
  readonly email: string
  readonly createdAt: string
  readonly displayName: string | null
}

export function toApiUser(row: UserRow): ApiUser {
  return { id: row.id, email: row.email, createdAt: row.created_at, displayName: row.display_name ?? null }
}

export function getUser(db: Database, id: number): ApiUser | null {
  const row = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null
  return row === null ? null : toApiUser(row)
}
