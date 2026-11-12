/** Every branch of the gate decision, as a table. */
import { describe, expect, test } from "bun:test"
import { type CheckStatus, type GateDecision, type GateInput, decideGate } from "../../src/verify/index.ts"

const base: GateInput = {
  mode: "gate",
  maxRounds: 3,
  selected: ["typecheck", "test"],
  latest: [],
  changedSinceLatest: false,
  reportsSent: 0,
  acknowledgement: null,
}

const ran = (...statuses: [string, CheckStatus][]) => statuses.map(([name, status]) => ({ name, status }))
const failingTest = ran(["typecheck", "passed"], ["test", "failed"])

const cases: [string, Partial<GateInput>, GateDecision][] = [
  ["mode off finishes without running anything", { mode: "off", latest: failingTest }, { kind: "finish" }],
  ["nothing changed and nothing ran: finish", { selected: [] }, { kind: "finish" }],
  ["changes and no results yet: run the selected checks", {}, { kind: "run_checks", checks: ["typecheck", "test"] }],
  ["report mode also runs checks", { mode: "report" }, { kind: "run_checks", checks: ["typecheck", "test"] }],
  ["files changed after the latest results: run again", { latest: failingTest, changedSinceLatest: true, reportsSent: 1 }, { kind: "run_checks", checks: ["typecheck", "test"] }],
  [
    "an interrupted result counts as not run",
    { latest: ran(["typecheck", "passed"], ["test", "interrupted"]) },
    { kind: "run_checks", checks: ["typecheck", "test"] },
  ],
  ["stale results but no selected checks: finish", { selected: [], latest: failingTest, changedSinceLatest: true }, { kind: "finish" }],
  ["all passed: finish", { latest: ran(["typecheck", "passed"], ["test", "passed"]) }, { kind: "finish" }],
  ["a failure: send the report and continue", { latest: failingTest }, { kind: "report_and_continue", failing: ["test"] }],
  [
    "timed out and could not start are failures too",
    { latest: ran(["typecheck", "timed_out"], ["test", "could_not_start"]) },
    { kind: "report_and_continue", failing: ["typecheck", "test"] },
  ],
  ["unchanged and unacknowledged after a report: report again", { latest: failingTest, reportsSent: 2 }, { kind: "report_and_continue", failing: ["test"] }],
  ["after maxRounds reports: finish unresolved", { latest: failingTest, reportsSent: 3 }, { kind: "finish_unresolved", reason: "max_rounds", failing: ["test"] }],
  [
    "acknowledged: finish unresolved",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: ["test"], reason: "needs a database" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "a check may be named by the label the report shows it with",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: [" test (bun test) "], reason: "the fixture is not mine to change" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "a name that merely starts like a failing check's does not name it",
    { latest: failingTest, reportsSent: 1, acknowledgement: { checks: ["tests", "test-e2e (bun e2e)"], reason: "r" } },
    { kind: "report_and_continue", failing: ["test"] },
  ],
  [
    "an acknowledgement may name more checks than fail",
    { latest: failingTest, acknowledgement: { checks: ["typecheck", "test"], reason: "r" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  [
    "acknowledging only some failures is not enough",
    { latest: ran(["typecheck", "failed"], ["test", "failed"]), acknowledgement: { checks: ["test"], reason: "r" } },
    { kind: "report_and_continue", failing: ["typecheck", "test"] },
  ],
  [
    "acknowledgement wins over the round limit",
    { latest: failingTest, reportsSent: 3, acknowledgement: { checks: ["test"], reason: "r" } },
    { kind: "finish_unresolved", reason: "acknowledged", failing: ["test"] },
  ],
  ["report mode never sends the model back", { mode: "report", latest: failingTest }, { kind: "finish_unresolved", reason: "report_mode", failing: ["test"] }],
]

describe("decideGate", () => {
  for (const [name, input, expected] of cases) test(name, () => expect(decideGate({ ...base, ...input })).toEqual(expected))
})
