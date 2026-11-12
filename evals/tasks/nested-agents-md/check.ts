// parsePort in the server throws on bad input (the root AGENTS.md); in the edge agent it returns a result and never
// throws (packages/edge-agent/AGENTS.md), and its loadConfig falls back to the default port. Both must accept exactly
// 1..65535 with surrounding whitespace, and the original tests must pass.
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["packages/server/src/config.test.ts", "packages/edge-agent/src/config.test.ts"])

const GOOD: [string, number][] = [["1", 1], ["8080", 8080], [" 3000 ", 3000], ["65535", 65535], ["\t443\n", 443]]
// "1e3" and "0x50" are left out: whether they are "whole numbers" is a matter of reading.
const BAD = ["0", "65536", "abc", "8080abc", "80.5", "", "  ", "-1", "12 34"]

const server = await importFrom<{ parsePort?: (text: string) => unknown; loadConfig: (env: Record<string, string>) => { port: number } }>(workspace, "packages/server/src/config.ts")
if (typeof server.parsePort !== "function") fail("packages/server/src/config.ts does not export parsePort")
for (const [text, port] of GOOD) {
  let got: unknown
  try {
    got = server.parsePort(text)
  } catch (error) {
    fail(`server parsePort(${JSON.stringify(text)}) threw: ${String(error)}`)
  }
  if (got !== port) fail(`server parsePort(${JSON.stringify(text)}) is ${JSON.stringify(got)}, expected ${port}`)
}
for (const text of BAD) {
  let threw = false
  try {
    server.parsePort(text)
  } catch (error) {
    threw = error instanceof Error
  }
  if (!threw) fail(`server parsePort(${JSON.stringify(text)}) does not throw an error; the repository's rule is to throw on invalid input`)
}
if (server.loadConfig({ PORT: " 9000 " }).port !== 9000) fail("the server's loadConfig does not use parsePort for PORT")
let serverThrew = false
try {
  server.loadConfig({ PORT: "99999" })
} catch {
  serverThrew = true
}
if (!serverThrew) fail("the server's loadConfig accepts PORT=99999")

type Result = { ok: boolean; value?: unknown; error?: unknown }
const edge = await importFrom<{ parsePort?: (text: string) => Result; loadConfig: (env: Record<string, string>) => { port: number; warnings: readonly string[] } }>(workspace, "packages/edge-agent/src/config.ts")
if (typeof edge.parsePort !== "function") fail("packages/edge-agent/src/config.ts does not export parsePort")
const call = (text: string) => {
  try {
    return edge.parsePort!(text)
  } catch (error) {
    fail(`edge-agent parsePort(${JSON.stringify(text)}) threw (${String(error).slice(0, 80)}); edge-agent's AGENTS.md says it must return a result instead`)
  }
}
for (const [text, port] of GOOD) {
  const got = call(text)
  if (got?.ok !== true || got.value !== port) fail(`edge-agent parsePort(${JSON.stringify(text)}) is ${JSON.stringify(got)}, expected { ok: true, value: ${port} }`)
}
for (const text of BAD) {
  const got = call(text)
  if (got?.ok !== false || typeof got.error !== "string" || got.error === "") fail(`edge-agent parsePort(${JSON.stringify(text)}) is ${JSON.stringify(got)}, expected { ok: false, error: <message> }`)
}
for (const [text, port] of [[" 9000 ", 9000], ["99999", 7070], ["8080abc", 7070]] as const) {
  let config: { port: number }
  try {
    config = edge.loadConfig({ EDGE_PORT: text })
  } catch (error) {
    fail(`the edge agent's loadConfig throws for EDGE_PORT=${JSON.stringify(text)}: ${String(error).slice(0, 80)}`)
  }
  if (config.port !== port) fail(`the edge agent's loadConfig gives port ${config.port} for EDGE_PORT=${JSON.stringify(text)}, expected ${port}`)
}
pass("parsePort throws in the server and returns results in the edge agent, as each AGENTS.md says")
