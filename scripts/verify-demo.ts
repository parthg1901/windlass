/**
 * Verification end to end, without a model: a tiny project with a failing
 * test and a config file, the harness's checks run the way the step loop will
 * run them, and exactly the text the model would be shown. Then the file is
 * fixed and the checks run again.
 *
 *   bun scripts/verify-demo.ts
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { loadConfig } from "../packages/core/src/config/index.ts"
import { createInterrupt } from "../packages/core/src/interrupt.ts"
import { type CheckResult, type GateInput, decideGate, renderReport, runChecks, selectChecks } from "../packages/core/src/verify/index.ts"

const root = mkdtempSync(join(tmpdir(), "lh-verify-demo-"))
const dir = join(root, "project")
mkdirSync(join(dir, ".git"), { recursive: true })
await Bun.write(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a - b\n}\n")
await Bun.write(
  join(dir, "math.test.ts"),
  `import { expect, test } from "bun:test"\nimport { add } from "./math.ts"\n\ntest("add", () => {\n  expect(add(1, 2)).toBe(3)\n})\n`,
)
await Bun.write(
  join(dir, `.${brand.directory}`, "config.json"),
  JSON.stringify({ checks: [{ name: "test", command: "bun test", when: ["**/*.ts"] }] }, null, 2),
)

const loaded = await loadConfig({ cwd: dir, home: join(root, "home"), env: {} })
const options = { cwd: loaded.projectDir, spillDir: join(root, "spill"), signal: createInterrupt().signal }
const changed = ["math.ts"]
const selected = selectChecks(loaded.config.checks, changed)
const gate = (latest: readonly CheckResult[], changedSinceLatest: boolean, reportsSent: number): GateInput => ({
  ...loaded.config.verify,
  selected: selected.map((item) => item.name),
  latest,
  changedSinceLatest,
  reportsSent,
  acknowledgement: null,
})

const show = (title: string, text: string) => console.log(`\n=== ${title}\n${text.replaceAll(root, "<tmp>")}`)

// The model says it is done after editing math.ts.
console.log(`config: ${loaded.sources.map((file) => file.replaceAll(root, "<tmp>")).join(", ")}`)
console.log("decision:", JSON.stringify(decideGate(gate([], false, 0))))
const first = await runChecks(selected, options)
const afterFirst = decideGate(gate(first, false, 0))
console.log("decision:", JSON.stringify(afterFirst))
show("shown to the model", renderReport(first))

// The model fixes the file and says it is done again.
await Bun.write(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")
console.log("\ndecision:", JSON.stringify(decideGate(gate(first, true, 1))))
const second = await runChecks(selected, options)
console.log("decision:", JSON.stringify(decideGate(gate(second, false, 1))))
show("recorded (the turn ends)", renderReport(second))

rmSync(root, { recursive: true, force: true })
