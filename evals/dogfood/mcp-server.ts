#!/usr/bin/env bun
// A small MCP server over stdio, written the way a user would write their first one, for the MCP part of a
// dogfood pass (see README.md beside this file). It speaks the handshake protocol (initialize, tools/list,
// tools/call) and answers anything else with "method not found", so the harness detects it as a legacy server.
//
//   bun evals/dogfood/mcp-server.ts [--log <file>]
//
// Its tools give answers the model cannot guess, so a pass can tell whether a tool was really called:
//   shelf_code {item}   the shelf code of an item in a made-up warehouse, derived from the item's name
//   inventory  {}       a fixed list of three items and their counts
// `--log <file>` appends one line per request (`call shelf_code {"item":"bolts"}`), so a pass can see what the
// server received and whether it was started at all.

import { appendFileSync } from "node:fs"

const argv = process.argv.slice(2)
const logFile = argv[0] === "--log" ? argv[1] : undefined
const log = (line: string) => {
  if (logFile !== undefined) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
}
log(`started pid ${process.pid}`)

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const TOOLS = [
  {
    name: "shelf_code",
    description: "Look up the shelf code of an item in the warehouse.",
    inputSchema: { type: "object", properties: { item: { type: "string", description: "The item's name." } }, required: ["item"] },
  },
  {
    name: "inventory",
    description: "List the items in the warehouse with their counts.",
    inputSchema: { type: "object", properties: {} },
  },
]

function shelfCode(item: string): string {
  let hash = 7
  for (const char of item.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 9973
  return `WH-${String.fromCharCode(65 + (hash % 26))}${String(hash).padStart(4, "0")}`
}

function call(name: string, args: { [key: string]: Json }): { content: { type: "text"; text: string }[]; isError?: boolean } {
  if (name === "shelf_code") {
    const item = typeof args.item === "string" ? args.item : ""
    if (item === "") return { content: [{ type: "text", text: "item is required" }], isError: true }
    return { content: [{ type: "text", text: `${item} is on shelf ${shelfCode(item)}.` }] }
  }
  if (name === "inventory") return { content: [{ type: "text", text: "bolts: 1200\nwashers: 340\nhinges: 17" }] }
  return { content: [{ type: "text", text: `no tool named ${name}` }], isError: true }
}

function answer(id: Json, result: Json) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}
function fail(id: Json, code: number, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)
}

let buffer = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (line === "") continue
    let message: { id?: Json; method?: string; params?: { [key: string]: Json } }
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params } = message
    if (method === undefined || id === undefined) continue // a notification or a response: nothing to answer
    log(method === "tools/call" ? `call ${String(params?.name)} ${JSON.stringify(params?.arguments ?? {})}` : method)
    if (method === "initialize") {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18"
      answer(id, { protocolVersion: asked, capabilities: { tools: {} }, serverInfo: { name: "warehouse", version: "0.1.0" } })
    } else if (method === "ping") answer(id, {})
    else if (method === "tools/list") answer(id, { tools: TOOLS as unknown as Json })
    else if (method === "tools/call") answer(id, call(String(params?.name), (params?.arguments ?? {}) as { [key: string]: Json }))
    else fail(id, -32601, `method not found: ${method}`)
  }
})
process.stdin.on("end", () => {
  log("stdin closed; exiting")
  process.exit(0)
})
