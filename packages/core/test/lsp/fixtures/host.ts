/**
 * A stand-in for the harness process: starts a registry with the scripted
 * server, opens a file so the server starts, prints `ready` once it runs, and
 * waits to be killed. The test kills it with SIGKILL and checks that the
 * server and its child died with it.
 *
 *   bun host.ts <workspace> <server pid file> <grandchild pid file>
 */
import { join } from "node:path"
import { planLspServers } from "../../../src/lsp/config.ts"
import { createLspRegistry } from "../../../src/lsp/registry.ts"
import { waitFor } from "../../../src/testing/wait.ts"

const [workspace, pidFile, grandchildFile] = process.argv.slice(2)
const registry = createLspRegistry({
  plan: planLspServers(
    { servers: { fixture: { command: process.execPath, args: [join(import.meta.dir, "server.ts"), "--pid-file", pidFile!, "--grandchild", grandchildFile!], languages: { plaintext: ["**/*.txt"] } } } },
    undefined,
    () => false,
  ),
  cwd: workspace!,
})
registry.observe(join(workspace!, "a.txt"), "hello")
await waitFor(() => registry.status()[0]?.state === "ready", { timeoutMs: 20_000, intervalMs: 20 }).catch(() => {})
console.log(registry.status()[0]?.state === "ready" ? "ready" : `not ready: ${registry.status()[0]?.error}`)
await new Promise(() => {})
