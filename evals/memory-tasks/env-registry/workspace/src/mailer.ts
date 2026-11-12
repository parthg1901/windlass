import { env } from "./config/settings.ts"

export interface Mail {
  readonly to: string
  readonly from: string
  readonly replyTo: string
  readonly subject: string
  readonly body: string
}

/** Where mail goes; the relay itself is out of scope here. */
export function relay() {
  return { host: env("SMTP_HOST"), port: Number(env("SMTP_PORT")) }
}

export function digestMail(to: string, items: readonly string[]): Mail {
  return { to, from: "digest@notifier.example", replyTo: env("REPLY_TO"), subject: `Your digest: ${items.length} new`, body: items.map((item) => `- ${item}`).join("\n") }
}
