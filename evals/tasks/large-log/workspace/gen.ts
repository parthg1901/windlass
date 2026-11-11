// Writes data/events.log, a large synthetic service log. Deterministic: the same seed gives the same bytes.
//   bun gen.ts
import { mkdir } from "node:fs/promises"

export const LINES = 150_000

/** mulberry32: a tiny seeded PRNG, so the log is identical on every machine. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MESSAGES = ["request served", "cache miss", "slow query", "retrying upstream", "session refreshed", "payload rejected"]
const CODES = ["E17", "E40", "E42", "E42", "E51", "E99"]

export function* events() {
  const next = random(20261111)
  const start = Date.UTC(2026, 9, 1)
  for (let i = 0; i < LINES; i++) {
    const roll = next()
    const level = roll < 0.9 ? "INFO" : roll < 0.97 ? "WARN" : "ERROR"
    const user = `u${String(1 + Math.floor(next() * 4000)).padStart(4, "0")}`
    const code = level === "INFO" ? "-" : CODES[Math.floor(next() * CODES.length)]!
    const message = MESSAGES[Math.floor(next() * MESSAGES.length)]!
    const time = new Date(start + i * 1700 + Math.floor(next() * 1000)).toISOString()
    const latency = Math.floor(next() * 900)
    yield `${time} level=${level} user=${user} code=${code} latency_ms=${latency} msg="${message}"`
  }
}

if (import.meta.main) {
  await mkdir("data", { recursive: true })
  const writer = Bun.file("data/events.log").writer()
  for (const line of events()) writer.write(line + "\n")
  await writer.end()
}
