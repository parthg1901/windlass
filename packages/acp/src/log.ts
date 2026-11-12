/**
 * Logging for the ACP server. stdout carries protocol messages and nothing
 * else, so every line goes to stderr (which editors keep as the agent's log)
 * unless a test passes its own sink.
 */
import { brand } from "@light-harness/core"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  readonly debug: (message: string) => void
  readonly info: (message: string) => void
  readonly warn: (message: string) => void
  readonly error: (message: string) => void
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/** The environment variable that sets the level: `debug`, `info` (default), `warn` or `error`. */
export const LOG_LEVEL_ENV = `${brand.envPrefix}ACP_LOG`

export function createLogger(options: { readonly level?: LogLevel; readonly write?: (line: string) => void } = {}): Logger {
  const threshold = RANK[options.level ?? "info"]
  const write = options.write ?? ((line: string) => process.stderr.write(line))
  const at =
    (level: LogLevel) =>
    (message: string): void => {
      if (RANK[level] < threshold) return
      write(`${brand.binary} acp ${level}: ${message}\n`)
    }
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }
}

export function levelFromEnv(value: string | undefined): LogLevel {
  return value === "debug" || value === "warn" || value === "error" ? value : "info"
}

/** A logger that drops everything, for tests that do not look at the log. */
export const silentLogger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
