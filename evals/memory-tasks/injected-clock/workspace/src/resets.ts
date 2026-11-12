export interface Reset {
  readonly token: string
  readonly userId: string
  readonly createdAt: number
}

const resets = new Map<string, Reset>()

/** Starts a password reset; the token goes into the emailed link. */
export function createReset(userId: string): Reset {
  const reset = { token: crypto.randomUUID(), userId, createdAt: Date.now() }
  resets.set(reset.token, reset)
  return reset
}

/** Uses a reset link: returns the user whose password may now be set. A link works once. */
export function useReset(token: string): string {
  const reset = resets.get(token)
  if (!reset) throw new Error("this reset link is not valid")
  resets.delete(token)
  return reset.userId
}
