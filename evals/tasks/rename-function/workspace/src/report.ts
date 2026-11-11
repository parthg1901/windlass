import { getUsr, getUsrsByTeam } from "./store.ts"

export function describe(id: number) {
  const user = getUsr(id)
  if (!user) return `#${id}: unknown`
  const teammates = getUsrsByTeam(user.team).filter((other) => other.id !== id).length
  return `#${id}: ${user.name} (${user.team}, ${teammates} teammates)`
}
