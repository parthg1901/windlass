#!/usr/bin/env bun
// Writes the dogfood hooks, and optionally a language server, into a configuration file, the way a user (or a
// repository) would add them by hand. It keeps every other key of the file.
//
//   bun evals/dogfood/hooks-config.ts --project <workspace> [--marker <word>] [--lsp <langserver.js>] [--wait-ms <n>]
//   bun evals/dogfood/hooks-config.ts --user <config home>  [--marker <word>] [--lsp <langserver.js>] [--wait-ms <n>]
//   bun evals/dogfood/hooks-config.ts --remove (--project <workspace> | --user <config home>)
//
// The hooks:
//   no-push      before `shell`: refuses a command that contains `git push`
//   no-env       before `read`, `edit`, `write` of `**/.env`: refuses
//   house-rule   after `edit` and `write`: a note ("HOUSE-RULE: ...") added to the result
//   no-scratch   at the end of a turn: sends the agent back while SCRATCH.md exists (maxStopRounds 2)
//
// `--marker <word>` ends the no-push command with a 190-character word that ends in <word>: an approval question
// shows the whole command only if <word> is on screen. `--lsp <file>` adds a language server "python" run as
// `node <file> --stdio` for `**/*.py` (pyright's `langserver.index.js` from a cache on the machine: install
// nothing). In a project's file (`--project`) each hook and the server wait for the user's approval.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { brand } from "../../packages/core/src/brand.ts"

const argv = process.argv.slice(2)
let file = ""
let marker: string | null = null
let lsp: string | null = null
let waitMs: number | null = null
let remove = false
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  const value = () => argv[++index] ?? usage()
  if (arg === "--user") file = join(resolve(value()), brand.directory, "config.json")
  else if (arg === "--project") file = join(resolve(value()), `.${brand.directory}`, "config.json")
  else if (arg === "--marker") marker = value()
  else if (arg === "--lsp") lsp = resolve(value())
  else if (arg === "--wait-ms") waitMs = Number(value())
  else if (arg === "--remove") remove = true
  else usage()
}
if (file === "") usage()

function usage(): never {
  console.error("usage: bun evals/dogfood/hooks-config.ts (--project <workspace> | --user <config home>) [--marker <word>] [--lsp <langserver.js>] [--wait-ms <n>] [--remove]")
  process.exit(2)
}

const config = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {}
if (remove) {
  delete config.hooks
  delete config.lsp
} else {
  const command = `${brand.envPrefix}HOOK_COMMAND`
  const tail = marker === null ? "" : `; : ${"x".repeat(190 - marker.length)}${marker}`
  config.hooks = {
    beforeTool: [
      {
        name: "no-push",
        tools: ["shell"],
        command: `case "$${command}" in *'git push'*) echo 'Pushing is not allowed here. Commit locally and tell the user.'; exit 2;; esac${tail}`,
      },
      {
        name: "no-env",
        tools: ["read", "edit", "write"],
        paths: ["**/.env"],
        command: "echo 'Files named .env hold secrets and are off limits.'; exit 2",
      },
    ],
    afterTool: [
      {
        name: "house-rule",
        tools: ["edit", "write"],
        command: "echo 'HOUSE-RULE: mention in your answer that the house rule was read.'; exit 2",
      },
    ],
    stop: [
      {
        name: "no-scratch",
        command: "if [ -e SCRATCH.md ]; then echo 'SCRATCH.md still exists. Delete it before you finish.'; exit 2; fi",
      },
    ],
    maxStopRounds: 2,
  }
  if (lsp !== null)
    config.lsp = {
      ...(waitMs === null ? {} : { waitMs }),
      servers: { python: { command: "node", args: [lsp, "--stdio"], languages: { python: ["**/*.py"] } } },
    }
}
mkdirSync(dirname(file), { recursive: true })
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log(`${remove ? "removed the hooks and the language server from" : "wrote the hooks" + (lsp === null ? "" : " and the language server") + " in"} ${file}`)
