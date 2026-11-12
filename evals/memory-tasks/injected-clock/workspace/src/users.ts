export interface User {
  readonly id: string
  readonly email: string
  readonly passwordHash: string | null
}

const users = new Map<string, User>()

export function addUser(id: string, email: string): User {
  const user = { id, email: email.trim().toLowerCase(), passwordHash: null }
  users.set(id, user)
  return user
}

export function setPasswordHash(id: string, hash: string): void {
  const user = users.get(id)
  if (!user) throw new Error(`no user ${id}`)
  users.set(id, { ...user, passwordHash: hash })
}
