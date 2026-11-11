import { type User, findUser } from "../../app/store.ts"

/** Published: called by the mobile apps as `getUser(id)`. */
export function getUser(id: string): User | null {
  return findUser(id)
}

/** Published. */
export function getUserName(id: string): string | null {
  return findUser(id)?.name ?? null
}
