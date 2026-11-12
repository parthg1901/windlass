#!/usr/bin/env bun
import { type Output, UsageError, add, done, list } from "./commands.ts"
import { storePath } from "./store.ts"

export async function main(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<Output> {
  const out: Output = { code: 0, stdout: [], stderr: [] }
  const [command, ...args] = argv
  const path = storePath(env)
  try {
    if (command === "add") await add(path, args, out)
    else if (command === "list") await list(path, args, out)
    else if (command === "done") await done(path, args, out, env)
    else throw new UsageError(`unknown command ${command ?? "(none)"}; commands: add, list, done`)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    out.code = 2
    out.stderr.push(`tasks: ${error.message}`)
  }
  return out
}

if (import.meta.main) {
  const out = await main(process.argv.slice(2))
  if (out.stdout.length > 0) console.log(out.stdout.join("\n"))
  if (out.stderr.length > 0) console.error(out.stderr.join("\n"))
  process.exit(out.code)
}
