import { HOUR, now } from "./lib/clock.ts"

export interface Invite {
  readonly code: string
  readonly email: string
  readonly expiresAt: number
}

const invites = new Map<string, Invite>()

export function invite(email: string): Invite {
  const item = { code: crypto.randomUUID().slice(0, 8), email: email.trim().toLowerCase(), expiresAt: now() + 72 * HOUR }
  invites.set(item.code, item)
  return item
}

export function acceptInvite(code: string): string {
  const item = invites.get(code)
  if (!item) throw new Error("this invitation does not exist")
  if (item.expiresAt <= now()) throw new Error("this invitation has expired")
  invites.delete(code)
  return item.email
}
