export interface User {
  readonly id: number
  readonly name: string
  readonly team: string
}

export const users: User[] = [
  { id: 1, name: "Ada", team: "core" },
  { id: 2, name: "Linus", team: "infra" },
  { id: 3, name: "Grace", team: "core" },
]

/** Looks a user up by numeric id. Returns undefined when there is no such user. */
export function getUsr(id: number): User | undefined {
  return users.find((user) => user.id === id)
}

export function getUsrsByTeam(team: string): User[] {
  return users.filter((user) => user.team === team)
}
