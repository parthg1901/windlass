// The chart shows WORKER highest and CRON lowest (make-chart.ts); services.json names them queue-worker and
// scheduler. Everything else in the file must be as it was; formatting is free.
import { join } from "node:path"
import { fail, pass, pristine, requireUnchanged, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["docs/cpu-last-night.png"])
type Service = Record<string, unknown> & { name: string }
const before = JSON.parse((await pristine(import.meta.dir)).get("deploy/services.json")!) as { region: string; services: Service[] }
let after: { region: string; services: Service[] }
try {
  after = await Bun.file(join(workspace, "deploy/services.json")).json()
} catch (error) {
  fail(`deploy/services.json is not valid JSON: ${String(error)}`)
}
const want = (service: Service) => ({ ...service, scaleUp: service.name === "queue-worker", scaleDown: service.name === "scheduler" })
const sorted = (services: Service[]) => [...services].sort((a, b) => a.name.localeCompare(b.name)).map((service) => JSON.stringify(Object.entries(service).sort()))
if (after.region !== before.region || Object.keys(after).sort().join() !== "region,services") fail("deploy/services.json changed outside the services")
const expected = sorted(before.services.map(want))
const actual = sorted(after.services ?? [])
for (const [index, line] of expected.entries()) {
  if (actual[index] !== line) {
    const name = before.services.map(want).sort((a, b) => a.name.localeCompare(b.name))[index]!.name
    const got = (after.services ?? []).find((service) => service.name === name)
    fail(`${name} is ${JSON.stringify(got)}; expected scaleUp ${name === "queue-worker"}, scaleDown ${name === "scheduler"} and nothing else changed`)
  }
}
if (actual.length !== expected.length) fail("services were added or removed")
pass("queue-worker scales up, scheduler scales down, nothing else changed")
