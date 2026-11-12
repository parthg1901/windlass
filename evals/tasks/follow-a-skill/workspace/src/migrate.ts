import { Database } from "bun:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface Migration {
  readonly name: string
  readonly up: string
  readonly down: string
}

export function readMigrations(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8")
      const match = /--\s*migrate:up\s*\n([\s\S]*?)--\s*migrate:down\s*\n([\s\S]*)$/.exec(text)
      if (!match) throw new Error(`${name}: needs "-- migrate:up" and "-- migrate:down" sections`)
      return { name, up: match[1]!.trim(), down: match[2]!.trim() }
    })
}

export function migrateUp(db: Database, migrations: readonly Migration[]) {
  for (const migration of migrations) db.exec(migration.up)
}

/** The schema as text: every table and index, in name order. */
export function dumpSchema(db: Database): string {
  const rows = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type DESC, name").all() as { sql: string }[]
  return `${rows.map((row) => `${row.sql};`).join("\n\n")}\n`
}

export function freshDatabase(dir: string) {
  const db = new Database(":memory:")
  migrateUp(db, readMigrations(dir))
  return db
}
