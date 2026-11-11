import { join } from "node:path"
import { fail, pass, pristine, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const original = await pristine(import.meta.dir)

const settingsText = await Bun.file(join(workspace, "settings.json")).text()
let settings: unknown
try {
  settings = JSON.parse(settingsText)
} catch {
  fail("settings.json is not valid JSON")
}
const expectedSettings = JSON.parse(original.get("settings.json")!)
expectedSettings.version = "2.4.0"
expectedSettings.features.telemetry = true
// Comparing serialisations also checks that key order was kept.
if (JSON.stringify(settings) !== JSON.stringify(expectedSettings)) fail(`settings.json is wrong: expected ${changed(expectedSettings, settings)}`)
if (!settingsText.includes('\n  "name"') || !settingsText.includes('\n    "telemetry"')) fail("settings.json lost its two-space indentation")

const deployText = await Bun.file(join(workspace, "deploy.yaml")).text()
let deploy: unknown
try {
  deploy = Bun.YAML.parse(deployText)
} catch {
  fail("deploy.yaml is not valid YAML")
}
const expectedDeploy = Bun.YAML.parse(original.get("deploy.yaml")!) as {
  services: { api: { replicas: number; env: Record<string, string> } }
}
expectedDeploy.services.api.replicas = 4
expectedDeploy.services.api.env.LOG_LEVEL = "debug"
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, inner]) => [key, sorted(inner)]))
      : value
if (JSON.stringify(sorted(deploy)) !== JSON.stringify(sorted(expectedDeploy))) fail(`deploy.yaml is wrong: expected ${changed(sorted(expectedDeploy), sorted(deploy))}`)
const comments = original.get("deploy.yaml")!.match(/#.*$/gm) ?? []
const lost = comments.filter((comment) => !deployText.includes(comment))
if (lost.length > 0) fail(`deploy.yaml lost a comment: ${lost[0]}`)
const order = ["services:", "  api:", "  worker:", "healthcheck:"].map((line) => deployText.indexOf(`\n${line}`))
if (order.some((index, i) => index < 0 || (i > 0 && index < order[i - 1]!))) fail("deploy.yaml sections were reordered or reformatted")
if (await Bun.file(join(workspace, "README.md")).text() !== original.get("README.md")) fail("README.md was changed")
pass("both config files have exactly the requested changes")

/** The first path where two parsed documents differ, as "path = expected (got actual)"; "key order" if only order does. */
function changed(expected: unknown, actual: unknown, path = ""): string {
  if (typeof expected === "object" && expected !== null && typeof actual === "object" && actual !== null) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    for (const key of keys) {
      const inner = changed((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}.${key}`)
      if (inner) return inner
    }
    return path === "" ? "the original key order" : ""
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? "" : `${path.slice(1)} = ${JSON.stringify(expected)} (got ${JSON.stringify(actual)})`
}
