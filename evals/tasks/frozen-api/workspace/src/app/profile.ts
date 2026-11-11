import { getUser } from "../api/v1/index.ts"

export function profileLine(id: string): string {
  const user = getUser(id)
  return user === null ? "unknown user" : `${user.name} (${user.team})`
}
