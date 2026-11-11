export const defaults = {
  timeoutMs: 10_000,
  retry: {
    attempts: 6,
    baseDelayMs: 250,
    factor: 2,
    maxDelayMs: 5_000,
  },
}
