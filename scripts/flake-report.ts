/**
 * Which tests failed across repeated runs, from their JUnit reports (`bun test --reporter=junit`).
 *
 *   bun scripts/flake-report.ts <directory of *.xml> [--runs <n>]
 *
 * Prints each test that failed with how many of the runs it failed in and its first failure message, as Markdown,
 * and appends the same to $GITHUB_STEP_SUMMARY when that is set. `--runs` is how many runs were made, so a run that
 * left no report (it crashed or was killed) is counted too. Exits 1 when anything failed or a report is missing.
 * Used by .github/workflows/stress.yml.
 */
import { appendFileSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
const dir = args[0]
if (dir === undefined || dir.startsWith("--")) {
  console.error("usage: bun scripts/flake-report.ts <directory of *.xml> [--runs <n>]")
  process.exit(2)
}
const runsIndex = args.indexOf("--runs")
const expectedRuns = runsIndex === -1 ? null : Number(args[runsIndex + 1])

const decode = (text: string) =>
  text
    .replace(/&#10;/g, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match === null ? "" : decode(match[1]!)
}

const reports = readdirSync(dir)
  .filter((name) => name.endsWith(".xml"))
  .sort()
const failures = new Map<string, { runs: Set<string>; message: string }>()
let tests = 0
for (const report of reports) {
  const xml = readFileSync(join(dir, report), "utf8")
  for (const match of xml.matchAll(/<testcase\b[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    tests += 1
    const body = match[2] ?? ""
    const failure = /<failure\b([^>]*)>/.exec(body) ?? /<failure\b([^>]*)\/>/.exec(body)
    if (failure === null) continue
    const tag = match[0].slice(0, match[0].indexOf(">"))
    const suite = attribute(tag, "classname")
    const key = `${attribute(tag, "file")} › ${suite === "" ? "" : `${suite} › `}${attribute(tag, "name")}`
    const entry = failures.get(key) ?? { runs: new Set<string>(), message: attribute(failure[1]!, "message").split("\n").slice(0, 6).join("\n") }
    entry.runs.add(report)
    failures.set(key, entry)
  }
}

const missing = expectedRuns === null ? 0 : Math.max(0, expectedRuns - reports.length)
const runs = expectedRuns ?? reports.length
const lines: string[] = []
lines.push(`### ${process.env.REPORT_TITLE ?? "Repeated test runs"}`, "")
lines.push(`${runs} run(s), ${reports.length} report(s), ${tests} test results.`, "")
if (missing > 0) lines.push(`**${missing} run(s) left no report** (crashed, killed or timed out): see the job log.`, "")
if (failures.size === 0) lines.push("No test failed.")
else {
  lines.push("| failed in | test |", "| --- | --- |")
  const sorted = [...failures].sort((a, b) => b[1].runs.size - a[1].runs.size || a[0].localeCompare(b[0]))
  for (const [key, entry] of sorted) lines.push(`| ${entry.runs.size} of ${runs} | ${key.replace(/\|/g, "\\|")} |`)
  lines.push("", "First failure of each:", "")
  for (const [key, entry] of sorted) lines.push(`<details><summary>${key}</summary>`, "", "```", entry.message, "```", "</details>", "")
}
const text = `${lines.join("\n")}\n`
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
process.exit(failures.size > 0 || missing > 0 ? 1 : 0)
