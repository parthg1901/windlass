export interface User {
  readonly id: string
  readonly name: string
  readonly team: string
}

const USERS: readonly User[] = [
  { id: "u1", name: "Ada", team: "core" },
  { id: "u2", name: "Lin", team: "mobile" },
]

export function findUser(id: string): User | null {
  return USERS.find((user) => user.id === id) ?? null
}
