/**
 * Prints the frozen tool list of a session of the real harness and what it
 * costs in every request: one line per tool with its estimated tokens
 * (`estimateTool`, the estimate the compaction policy uses), then the total.
 * No model is called: a scripted provider answers one prompt in a throwaway
 * directory, and the tools are read off the request it was sent.
 *
 *   bun scripts/tool-block.ts            # the default list (verification on, memory off)
 *   bun scripts/tool-block.ts --json
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../packages/core/src/assembly.ts"
import { resolveConfig } from "../packages/core/src/config/schema.ts"
import { estimateTool } from "../packages/core/src/context/estimate.ts"
import { FakeProvider, script } from "../packages/core/src/testing/fake-provider.ts"

const root = mkdtempSync(join(tmpdir(), "tool-block-"))
const provider = new FakeProvider([[script.text("ok")]])
const harness = createHarness({
  dataDir: join(root, "data"),
  provider,
  log: () => {},
  // Nothing of this machine's configuration: the list is the build's default.
  engine: { loadConfig: async (cwd) => ({ config: resolveConfig({}), projectDir: cwd }), snapshots: null, approval: null },
})
try {
  const session = harness.engine.createSession({ cwd: root, settings: { model: "model", reasoningEffort: null } })
  session.send("hello")
  await session.settled()
  const tools = provider.requests[0]?.tools ?? []
  const rows = tools.map((tool) => ({ name: tool.name, tokens: estimateTool(tool), descriptionChars: tool.description.length }))
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  if (process.argv.includes("--json")) console.log(JSON.stringify({ count: rows.length, total, tools: rows }, null, 2))
  else {
    for (const row of rows) console.log(`${String(row.tokens).padStart(6)}  ${row.name}`)
    console.log(`${String(total).padStart(6)}  total, ${rows.length} tools (estimated tokens)`)
  }
} finally {
  await harness.close()
  rmSync(root, { recursive: true, force: true })
}
