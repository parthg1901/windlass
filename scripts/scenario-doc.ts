/**
 * Keeps the scenario index in docs/step-loop-scenarios.md in step with the
 * scenario modules in packages/core/test/scenarios.
 *
 *   bun scripts/scenario-doc.ts           print the generated section
 *   bun scripts/scenario-doc.ts --write   rewrite it in the document
 *
 * A test (scenarios.test.ts) fails when the document and the modules differ.
 */
import { join } from "node:path"
import { SCENARIOS_END, SCENARIOS_START, renderScenarios } from "../packages/core/test/scenarios/render.ts"

const path = join(import.meta.dir, "..", "docs", "step-loop-scenarios.md")
const section = renderScenarios()

if (!process.argv.includes("--write")) {
  console.log(section)
  process.exit(0)
}

const document = await Bun.file(path).text()
const start = document.indexOf(SCENARIOS_START)
const end = document.indexOf(SCENARIOS_END)
if (start === -1 || end === -1 || end < start) throw new Error(`${path} has no scenario markers`)
await Bun.write(path, `${document.slice(0, start)}${SCENARIOS_START}\n\n${section}\n\n${document.slice(end)}`)
console.log(`rewrote the scenario section of ${path}`)
