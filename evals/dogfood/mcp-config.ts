#!/usr/bin/env bun
// Writes an `mcp` server entry for the dogfood MCP server (mcp-server.ts beside this file) into a configuration
// file, the way a user would add one by hand. It keeps every other key of the file.
//
//   bun evals/dogfood/mcp-config.ts --user <config home> [--name <server>] [--log <file>] [--trusted]
//   bun evals/dogfood/mcp-config.ts --project <workspace> [--name <server>] [--log <file>] [--trusted]
//   bun evals/dogfood/mcp-config.ts --remove (--user <config home> | --project <workspace>) [--name <server>]
//
// `--user <dir>` writes `<dir>/<brand.directory>/config.json`: point XDG_CONFIG_HOME at that directory for the run,
// so the user's real configuration is never touched. `--project <dir>` writes `<dir>/.<brand.directory>/config.json`
// (a project's server waits for the user's approval before it starts). `--trusted` sets `"untrusted": false`, so a
// result does not taint the session. `--log` makes the server log every request it receives.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"

const argv = process.argv.slice(2)
let file = ""
let name = "warehouse"
let logFile: string | null = null
let trusted = false
let remove = false
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  const value = () => argv[++index] ?? usage()
  if (arg === "--user") file = join(resolve(value()), brand.directory, "config.json")
  else if (arg === "--project") file = join(resolve(value()), `.${brand.directory}`, "config.json")
  else if (arg === "--name") name = value()
  else if (arg === "--log") logFile = resolve(value())
  else if (arg === "--trusted") trusted = true
  else if (arg === "--remove") remove = true
  else usage()
}
if (file === "") usage()

function usage(): never {
  console.error("usage: bun evals/dogfood/mcp-config.ts (--user <config home> | --project <workspace>) [--name <server>] [--log <file>] [--trusted] [--remove]")
  process.exit(2)
}

const config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
const mcp = (config.mcp ?? {}) as { servers?: Record<string, unknown> }
const servers = { ...(mcp.servers ?? {}) }
if (remove) delete servers[name]
else
  servers[name] = {
    command: process.execPath,
    args: [join(import.meta.dir, "mcp-server.ts"), ...(logFile === null ? [] : ["--log", logFile])],
    ...(trusted ? { untrusted: false } : {}),
  }
config.mcp = { ...mcp, servers }
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log(`${remove ? "removed" : "wrote"} mcp server "${name}" ${remove ? "from" : "in"} ${file}`)
