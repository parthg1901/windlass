// Compares the package's public API (every export of src/index.ts, with its arity) with api-report.txt, so that an
// API change is always a reviewed change to that file.
//
//   bun scripts/api-check.ts            exit 1 and a diff when they differ
//   bun scripts/api-check.ts --update   rewrite api-report.txt from the code
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const api = (await import(join(root, "src/index.ts"))) as Record<string, unknown>
const lines = Object.keys(api)
  .sort()
  .map((name) => {
    const value = api[name]
    return typeof value === "function" ? `function ${name}(${value.length})` : `const ${name}: ${typeof value}`
  })
const current = `${lines.join("\n")}\n`
const reportPath = join(root, "api-report.txt")
if (process.argv.includes("--update")) {
  await Bun.write(reportPath, current)
  console.log("api-report.txt updated")
  process.exit(0)
}
const report = await Bun.file(reportPath).text()
if (report === current) {
  console.log("api-report.txt matches the code")
  process.exit(0)
}
const want = new Set(report.trim().split("\n"))
const have = new Set(current.trim().split("\n"))
for (const line of want) if (!have.has(line)) console.log(`- ${line}`)
for (const line of have) if (!want.has(line)) console.log(`+ ${line}`)
console.log("The public API differs from api-report.txt. If the change is intended, run `bun scripts/api-check.ts --update` and commit api-report.txt with it.")
process.exit(1)
