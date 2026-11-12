import { type Result, err, ok } from "./result.ts"

export interface AgentConfig {
  readonly port: number
  readonly heartbeatSeconds: number
  readonly warnings: readonly string[]
}

const DEFAULT_PORT = 7070
const DEFAULT_HEARTBEAT = 30

export function parseHeartbeat(text: string): Result<number> {
  const value = Number(text.trim())
  if (!Number.isInteger(value) || value < 5 || value > 3600) return err(`heartbeat ${JSON.stringify(text)} is not 5 to 3600 seconds`)
  return ok(value)
}

/** The agent's settings from its environment; a bad value falls back to the default with a warning. */
export function loadConfig(env: Record<string, string | undefined>): AgentConfig {
  const warnings: string[] = []
  // FIXME: "8080abc" becomes 8080 and "99999" is accepted.
  const port = env.EDGE_PORT === undefined ? DEFAULT_PORT : Number.parseInt(env.EDGE_PORT, 10) || DEFAULT_PORT
  let heartbeatSeconds = DEFAULT_HEARTBEAT
  if (env.EDGE_HEARTBEAT !== undefined) {
    const parsed = parseHeartbeat(env.EDGE_HEARTBEAT)
    if (parsed.ok) heartbeatSeconds = parsed.value
    else warnings.push(`${parsed.error}; using ${DEFAULT_HEARTBEAT}`)
  }
  return { port, heartbeatSeconds, warnings }
}
