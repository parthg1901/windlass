import { getUsr, users } from "../src/store.ts"

// Prints the seed users, checking each can be found again by id.
for (const user of users) {
  if (getUsr(user.id) !== user) throw new Error(`lookup failed for ${user.id}`)
  console.log(`seeded ${user.name}`)
}
