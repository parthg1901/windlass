import { now } from "./lib/runtime.ts"

export interface AuditEntry {
  readonly at: number
  readonly userId: string
  readonly action: "signed-in" | "signed-out" | "reset-requested" | "password-changed"
}

const log: AuditEntry[] = []

export function record(userId: string, action: AuditEntry["action"]): void {
  log.push({ at: now(), userId, action })
}

export function entriesFor(userId: string): AuditEntry[] {
  return log.filter((entry) => entry.userId === userId)
}
