import { digestMail, type Mail } from "./mailer.ts"

export interface Subscriber {
  readonly email: string
  readonly items: readonly string[]
}

const BATCH_SIZE = 50

/** Sends the daily digest to everyone with something new, BATCH_SIZE mails per call to `send`. Returns the number sent. */
export async function sendDigests(subscribers: readonly Subscriber[], send: (batch: Mail[]) => Promise<void>): Promise<number> {
  const mails = subscribers.filter((subscriber) => subscriber.items.length > 0).map((subscriber) => digestMail(subscriber.email, subscriber.items))
  for (let start = 0; start < mails.length; start += BATCH_SIZE) await send(mails.slice(start, start + BATCH_SIZE))
  return mails.length
}
