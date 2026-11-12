// Every environment variable the service reads is declared here, with its default and what it does. Ops set
// variables from docs/env.md, which `bun run env:docs` writes from this list; a variable read anywhere else is
// invisible to them.

export const ENV = {
  SMTP_HOST: { default: "localhost", description: "mail relay host" },
  SMTP_PORT: { default: "2525", description: "mail relay port" },
  QUEUE_URL: { default: "memory://", description: "where outgoing messages are queued" },
  REPLY_TO: { default: "support@notifier.example", description: "reply address on every mail" },
} as const satisfies Record<string, { default: string; description: string }>

export type EnvName = keyof typeof ENV

/** The variable's value, or its declared default. */
export function env(name: EnvName): string {
  return process.env[name] ?? ENV[name].default
}
