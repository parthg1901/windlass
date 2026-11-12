/**
 * MCP servers behind the two bridge tools, against the scripted test servers.
 * Prints what the model would see: the fixed tool specs, the catalogue as it is
 * appended while servers connect late, a search, calls, and what shutdown leaves.
 *
 *   bun scripts/mcp-demo.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import type { CallId, MessageId, SessionId } from "../packages/core/src/id.ts"
import { createInterrupt } from "../packages/core/src/interrupt.ts"
import { mcpBridgeTools, mcpResultSource } from "../packages/core/src/mcp/bridge.ts"
import { catalogueUpdate } from "../packages/core/src/mcp/catalogue.ts"
import { resolveMcpConfig } from "../packages/core/src/mcp/config.ts"
import { createMcpRegistry } from "../packages/core/src/mcp/registry.ts"
import { createToolRuntime } from "../packages/core/src/tool/runtime.ts"
import { specOf } from "../packages/core/src/tool/tool.ts"
import { startHttpFixture } from "../packages/core/test/mcp/fixtures/http-server.ts"

const fixture = join(import.meta.dir, "../packages/core/test/mcp/fixtures/stdio-server.ts")
const stdio = (...flags: string[]) => ({ command: process.execPath, args: [fixture, ...flags] })
const scratch = mkdtempSync(join(tmpdir(), `${brand.binary}-mcp-demo-`))
const remote = startHttpFixture({ era: "modern", flags: ["--only", "slow,region", "--name", "remote"] })

const config = resolveMcpConfig({
  servers: {
    github: stdio("--only", "create_issue,echo,add,image,hang,add_tool"),
    notes: { ...stdio("--era", "legacy", "--startup-delay", "1500", "--only", "echo", "--name", "notes"), timeoutSeconds: 5 },
    broken: stdio("--crash-on-start"),
    remote: { url: remote.url },
  },
})
const registry = createMcpRegistry({ servers: config.servers, cwd: process.cwd(), backoff: { initialMs: 2000 } })
const tools = mcpBridgeTools(() => registry)
const runtime = createToolRuntime({ tools, spillDir: join(scratch, "spill"), putBlob: (bytes, mediaType) => ({ hash: `sha256-of-${bytes.length}-bytes`, mediaType }) })

const rule = (title: string) => console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`)
let calls = 0
const call = async (name: string, args: unknown, signal = createInterrupt().signal) => {
  calls += 1
  const outcome = await runtime.run({
    name,
    argumentsText: JSON.stringify(args),
    context: {
      sessionId: "ses_demo" as SessionId,
      messageId: "msg_demo" as MessageId,
      callId: `call_${calls}` as CallId,
      cwd: process.cwd(),
      signal,
      progress: (update) => console.log(`   (progress, not stored: ${update.text})`),
    },
  })
  console.log(`> ${name} ${JSON.stringify(args)}\n[${outcome.kind}, ${outcome.settlement.outcome}]`)
  console.log(outcome.settlement.output)
  const source = mcpResultSource(outcome.settlement.display)
  console.log(`   (recorded source: ${JSON.stringify(source)}${outcome.settlement.attachments.length > 0 ? `; attachments ${JSON.stringify(outcome.settlement.attachments)}` : ""})\n`)
}

// What the model has for source "mcp": the fold the engine keeps over appended messages.
let known: string | null | undefined
const appendIfChanged = (when: string) => {
  const update = catalogueUpdate(known, registry.catalogue())
  if (update === null) return console.log(`[${when}] catalogue unchanged: nothing appended`)
  known = update.fingerprint
  console.log(`[${when}] appended instruction message (source "mcp", fingerprint ${update.fingerprint?.slice(0, 12) ?? "null"}):\n${update.text}`)
}

rule("The tool list: two fixed tools, whatever is configured")
for (const tool of tools) {
  const spec = JSON.stringify(specOf(tool))
  console.log(`${tool.name} (effect ${tool.effect}), spec sha256 ${new Bun.CryptoHasher("sha256").update(spec).digest("hex").slice(0, 16)}:\n  ${tool.description}`)
}

rule("Start: returns at once, servers connect in the background")
const started = performance.now()
registry.start()
console.log(`start() returned after ${(performance.now() - started).toFixed(1)} ms`)
appendIfChanged("first step boundary")
while (registry.servers().length < 2) await Bun.sleep(20)
appendIfChanged(`step boundary at ${Math.round(performance.now() - started)} ms`)
appendIfChanged("next step boundary")
while (registry.status().find((s) => s.name === "notes")?.state !== "ready") await Bun.sleep(20)
appendIfChanged(`step boundary at ${Math.round(performance.now() - started)} ms (the slow legacy server is up)`)

rule("Status (for a UI, never shown to the model)")
for (const s of registry.status())
  console.log(
    `${s.name.padEnd(7)} ${s.transport.padEnd(5)} ${s.state.padEnd(9)} ${(s.era ?? "-").padEnd(6)} ${(s.protocolVersion ?? "-").padEnd(10)} tools=${s.tools}${s.error === null ? "" : ` error: ${s.error}`}`,
  )

rule("Search")
await call("mcp_search", { query: "issue" })
await call("mcp_search", { query: "create issue", includeSchema: true, limit: 1 })

rule("Calls")
await call("mcp_call", { server: "github", tool: "create_issue", arguments: { repo: "acme/web", title: "Login fails on Safari" } })
await call("mcp_call", { server: "github", tool: "image" })
await call("mcp_call", { server: "remote", tool: "slow", arguments: { ms: 150 } })
await call("mcp_call", { server: "github", tool: "create_issue", arguments: { repo: "acme", titel: "typo" } })
await call("mcp_call", { server: "githb", tool: "echo", arguments: { text: "x" } })
await call("mcp_call", { server: "broken", tool: "echo", arguments: { text: "x" } })
const interrupt = createInterrupt()
setTimeout(() => interrupt.interrupt("user"), 300)
await call("mcp_call", { server: "github", tool: "hang" }, interrupt.signal)

rule("A server changes its tools mid-session")
await call("mcp_call", { server: "github", tool: "add_tool", arguments: { name: "close_issue" } })
while (!registry.catalogue()?.value.includes("close_issue")) await Bun.sleep(20)
appendIfChanged("next step boundary")

rule("Shutdown")
const pids = registry.status().flatMap((s) => (s.pid === null ? [] : [s.pid]))
await registry.stop()
await remote.stop()
await Bun.sleep(100)
const alive = pids.filter((pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
})
console.log(`server processes before stop: ${pids.join(", ")}; still running after: ${alive.length === 0 ? "none" : alive.join(", ")}`)
rmSync(scratch, { recursive: true, force: true })
