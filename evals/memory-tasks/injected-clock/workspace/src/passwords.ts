/** The rules a new password must meet; the message says what is missing. */
export function passwordProblem(password: string): string | null {
  if (password.length < 12) return "use at least 12 characters"
  if (!/[a-z]/i.test(password) || !/\d/.test(password)) return "use letters and at least one digit"
  return null
}
