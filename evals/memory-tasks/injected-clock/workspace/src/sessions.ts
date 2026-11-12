import { HOUR, now } from "./clock.ts"

export interface Session {
  readonly token: string
  readonly userId: string
  readonly expiresAt: number
}

const sessions = new Map<string, Session>()
const LIFETIME = 12 * HOUR

export function startSession(userId: string): Session {
  const session = { token: crypto.randomUUID(), userId, expiresAt: now() + LIFETIME }
  sessions.set(session.token, session)
  return session
}

/** The user a session token belongs to, or null when it is unknown or has expired. */
export function sessionUser(token: string): string | null {
  const session = sessions.get(token)
  if (!session || session.expiresAt <= now()) return null
  return session.userId
}
