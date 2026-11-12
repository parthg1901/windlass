#!/usr/bin/env bun
// A local stand-in for an OpenTelemetry collector: it listens on 127.0.0.1, appends the body of every request to a
// file (one line per request: the path, then the JSON body) and answers 200. For reading what live telemetry
// really sends: turn it on in a throwaway user config with `"endpoint": "http://127.0.0.1:<port>"`, run a turn,
// then search the file for your prompt, paths and commands.
//
//   bun evals/dogfood/otel-collector.ts --out <file> [--port <n>]     (prints the address; stop it by PID)
//   bun evals/dogfood/otel-collector.ts --check <file> <word>...      (counts each word in what was received,
//                                                                      and lists the attribute keys seen)

import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const argv = process.argv.slice(2)

if (argv[0] === "--check") {
  const file = argv[1]
  if (file === undefined) usage()
  const text = readFileSync(resolve(file), "utf8")
  const lines = text.split("\n").filter((line) => line !== "")
  console.log(`${lines.length} request(s), ${text.length} characters`)
  const keys = new Set<string>()
  let spans = 0
  for (const line of lines) {
    const body = JSON.parse(line.slice(line.indexOf(" ") + 1)) as unknown
    walk(body)
  }
  function walk(value: unknown): void {
    if (Array.isArray(value)) for (const item of value) walk(item)
    else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>
      if (typeof record.key === "string" && "value" in record) keys.add(record.key)
      if (typeof record.spanId === "string") spans += 1
      for (const item of Object.values(record)) walk(item)
    }
  }
  console.log(`${spans} span(s); attribute keys: ${[...keys].sort().join(", ")}`)
  for (const word of argv.slice(2)) console.log(`${text.split(word).length - 1}  ${word}`)
  process.exit(0)
}

let out = ""
let port = 0
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  const value = () => argv[++index] ?? usage()
  if (arg === "--out") out = resolve(value())
  else if (arg === "--port") port = Number(value())
  else usage()
}
if (out === "") usage()

function usage(): never {
  console.error("usage: bun evals/dogfood/otel-collector.ts --out <file> [--port <n>] | --check <file> <word>...")
  process.exit(2)
}

writeFileSync(out, "")
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const body = await request.text()
    appendFileSync(out, `${new URL(request.url).pathname} ${body.replaceAll("\n", " ")}\n`)
    return new Response("{}", { headers: { "content-type": "application/json" } })
  },
})
console.log(`collector: http://127.0.0.1:${server.port} -> ${out} (pid ${process.pid})`)
