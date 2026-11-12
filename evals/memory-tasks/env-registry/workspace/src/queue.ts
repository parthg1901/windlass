import { env } from "./config/env.ts"

const queued: unknown[] = []

export function enqueue(message: unknown): void {
  if (!env("QUEUE_URL").startsWith("memory://")) throw new Error(`queue ${env("QUEUE_URL")} is not reachable from tests`)
  queued.push(message)
}

export function drain(): unknown[] {
  return queued.splice(0)
}
