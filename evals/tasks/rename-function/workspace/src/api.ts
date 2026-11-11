import * as store from "./store.ts"

/** Handles GET /users/:id. */
export function handleGetUser(id: string) {
  const user = store.getUsr(Number(id))
  return user ? { status: 200, body: user } : { status: 404, body: { error: "not found" } }
}
