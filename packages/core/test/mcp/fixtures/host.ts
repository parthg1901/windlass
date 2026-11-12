/**
 * A stand-in for the harness process: starts a registry with one scripted
 * server, prints `ready` once it is connected, and waits to be killed. The
 * test kills it with SIGKILL and checks that the server's process group died with it.
 *
 *   bun host.ts <server pid file> <grandchild pid file>
 */
import { join } from "node:path"
import { resolveMcpConfig } from "../../../src/mcp/config.ts"
import { createMcpRegistry } from "../../../src/mcp/registry.ts"

const [pidFile, grandchildFile] = process.argv.slice(2)
const server = join(import.meta.dir, "stdio-server.ts")
const registry = createMcpRegistry({
  servers: resolveMcpConfig({
    servers: { fixture: { command: process.execPath, args: [server, "--pid-file", pidFile!, "--grandchild", grandchildFile!] } },
  }).servers,
  cwd: process.cwd(),
  probeMs: 300,
})
registry.start()
await registry.settled(10_000)
console.log(registry.status()[0]?.state === "ready" ? "ready" : `not ready: ${registry.status()[0]?.error}`)
await new Promise(() => {})
