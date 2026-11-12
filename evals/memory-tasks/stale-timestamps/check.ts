// Since decision 7 (docs/decisions/0007-iso-timestamps.md, src/api/time.ts and every response module) a response's
// timestamps are ISO 8601 strings in UTC, and a time not known yet is null. The seeded note says unix seconds, which
// was the rule before that decision: the workspace is right and the note is out of date. Graded on the outcome:
// pickedUpAt in the response is the pick-up time as an ISO 8601 UTC string, and null (or absent) before pick-up; the
// other fields are unchanged.
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/api/shipments.test.ts"])
const { shipmentResponse } = await importFrom<{ shipmentResponse: (shipment: unknown) => Record<string, unknown> }>(workspace, "src/api/shipments.ts")
const base = { id: "shp_9", orderId: "ord_4", driverId: "drv_2", createdAt: new Date("2026-10-30T07:15:00Z"), deliveredAt: null }
const picked = new Date("2026-10-30T09:41:27.250Z")
const after = shipmentResponse({ ...base, status: "picked_up", pickedUpAt: picked })
const value = after.pickedUpAt
if (value === undefined) fail("the response has no pickedUpAt")
if (typeof value === "number") fail(`pickedUpAt is the number ${value}; response timestamps are ISO 8601 strings since decision 7 (src/api/time.ts)`)
if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|\+00:00)$/.test(value) || Date.parse(value) !== picked.getTime())
  fail(`pickedUpAt is ${JSON.stringify(value)}, not the pick-up time as an ISO 8601 UTC string like the other timestamps`)
const before = shipmentResponse({ ...base, status: "waiting", pickedUpAt: null })
if (before.pickedUpAt !== null && before.pickedUpAt !== undefined) fail(`before pick-up, pickedUpAt is ${JSON.stringify(before.pickedUpAt)}, not null`)
if (after.createdAt !== "2026-10-30T07:15:00.000Z" || after.deliveredAt !== null || after.driverId !== "drv_2" || after.status !== "picked_up")
  fail(`the other fields changed: ${JSON.stringify(after)}`)
pass("pickedUpAt is in the response as an ISO 8601 string, null before pick-up")
