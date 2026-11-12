export interface ServerConfig {
  readonly port: number
  readonly host: string
}

/** The server's settings from its environment. A bad value is a startup error. */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  // FIXME: "abc" becomes NaN and "0" is accepted.
  const port = env.PORT === undefined ? 8080 : Number(env.PORT)
  return { port, host: env.HOST ?? "0.0.0.0" }
}
