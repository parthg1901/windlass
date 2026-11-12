/** Today's date as YYYY-MM-DD, in local time. `TASKS_TODAY` overrides it (the tests use it). */
export function today(env: Record<string, string | undefined> = process.env): string {
  if (env.TASKS_TODAY) return env.TASKS_TODAY
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}
