export interface OutgoingMail {
  readonly to: string
  readonly subject: string
  readonly text: string
}

export const outbox: OutgoingMail[] = []

export function resetMail(to: string, token: string): OutgoingMail {
  const mail = { to, subject: "Reset your password", text: `Open https://id.example/reset/${token} to choose a new password.` }
  outbox.push(mail)
  return mail
}
