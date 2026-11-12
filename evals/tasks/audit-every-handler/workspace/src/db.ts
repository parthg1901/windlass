// An in-memory table store with the same interface as the production one (src/db.pg.ts is not in this repo).

export interface Row {
  readonly id: string
}

export interface Db {
  insert<T extends Row>(table: string, row: Omit<T, "id">): T
  get<T extends Row>(table: string, id: string): T | undefined
  update<T extends Row>(table: string, id: string, patch: Partial<T>): T
  remove(table: string, id: string): void
  all<T extends Row>(table: string): T[]
}

export function createDb(): Db {
  const tables = new Map<string, Map<string, Row>>()
  let next = 0
  const table = (name: string) => {
    let rows = tables.get(name)
    if (!rows) tables.set(name, (rows = new Map()))
    return rows
  }
  return {
    insert<T extends Row>(name: string, row: Omit<T, "id">) {
      next += 1
      const stored = { ...row, id: `${name.slice(0, 3)}_${next}` } as unknown as T
      table(name).set(stored.id, stored)
      return stored
    },
    get<T extends Row>(name: string, id: string) {
      return table(name).get(id) as T | undefined
    },
    update<T extends Row>(name: string, id: string, patch: Partial<T>) {
      const current = table(name).get(id)
      if (!current) throw new Error(`no row ${id} in ${name}`)
      const stored = { ...current, ...patch, id } as T
      table(name).set(id, stored)
      return stored
    },
    remove(name: string, id: string) {
      table(name).delete(id)
    },
    all<T extends Row>(name: string) {
      return [...table(name).values()] as T[]
    },
  }
}
