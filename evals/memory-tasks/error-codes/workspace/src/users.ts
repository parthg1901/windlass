import { AppError } from "./errors/app-error.ts"

export interface User {
  readonly id: number
  readonly name: string
  readonly email: string
}

const users: User[] = []

export function createUser(input: { name: string; email: string }): User {
  if (input.name.trim() === "") throw new AppError("E4009")
  if (input.email.trim() === "") throw new AppError("E4010")
  if (users.some((user) => user.email === input.email.trim().toLowerCase())) throw new AppError("E4008", input.email)
  const user = { id: users.length + 1, name: input.name.trim(), email: input.email.trim().toLowerCase() }
  users.push(user)
  return user
}

/** Older admin tool code; still throws plain errors. */
export function renameUser(email: string, name: string): User {
  const index = users.findIndex((user) => user.email === email.trim().toLowerCase())
  if (index === -1) throw new Error("no such user")
  if (name.trim() === "") throw new Error("name is required")
  const user = { ...users[index]!, name: name.trim() }
  users[index] = user
  return user
}

export function findUser(email: string): User | undefined {
  return users.find((user) => user.email === email.trim().toLowerCase())
}
