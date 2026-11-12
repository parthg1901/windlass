// The audit trail. Every change to stored data is recorded here: who did what to which row, in order.
// In production the entries are shipped to the compliance store; tests read `auditLog` directly.

export interface AuditEntry {
  readonly action: string
  readonly id: string
  readonly at: number
}

export const auditLog: AuditEntry[] = []

/** Records one change. `action` is `<entity>.<verb>` (docs/audit.md); `id` is the row's ID. */
export function audit(action: string, id: string): void {
  auditLog.push({ action, id, at: Date.now() })
}

export function clearAuditLog(): void {
  auditLog.length = 0
}
