/**
 * With `content` off, the span of a turn that failed says how it failed as a class and nothing in words,
 * through the engine and its live export.
 *
 * docs/telemetry.md promises that by default no text of the user's is sent: "no prompt, no answer, no file
 * path, no command". The sentence of a failed turn is written from the session: with `unattended: "stop"` it
 * quotes the refusal ("... needs the user's approval for writing <path>"). `mapSession` used to put it in the
 * turn span's status whatever `content` said. Now a status message is set only with content on.
 */
import { afterAll, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import type { TelemetryConfig } from "../../src/telemetry/config.ts"
import type { ExportReport } from "../../src/telemetry/exporter.ts"
import type { Span } from "../../src/telemetry/span.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, removeHarnessDirectories } from "../engine/harness.ts"
import { measured } from "../scenarios/script.ts"

afterAll(removeHarnessDirectories)

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
// Export on, in the user's own file, with `content` left at its default.
const ON: ConfigFile = { verify: { mode: "off" }, telemetry: { enabled: true, endpoint: "http://collector.invalid:4318" } }
const sandbox: CommandSandbox = {
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("a scripted tool spawns nothing")
  },
  policy: () => {
    throw new Error("a scripted tool spawns nothing")
  },
}
// An unattended run that ends at the first call that would ask (`--unattended stop`).
const approval: ApprovalSetup = { sandbox, secrets: [], home: "/home/user", user: { mode: "auto", unattended: "stop" } }

test("with content off, no file path reaches the collector, also when the turn fails", async () => {
  const batches: Span[][] = []
  // A function in place of the collector: nothing leaves the process.
  const send = async (spans: readonly Span[], _config: TelemetryConfig): Promise<ExportReport> => {
    batches.push([...spans])
    return { batches: [], sent: spans.length, failed: 0 }
  }
  const h = new Harness({ userConfig: ON, telemetry: { mapDelayMs: 0, env: {}, send }, approval })
  try {
    // A write outside the working directory asks; nobody is there, so the run stops. The scripted tool never runs.
    h.provider.enqueue([call("write", { path: "/srv/payroll-2026/salaries.csv", content: "EXAMPLE_VALUE_123" }), U], [script.text("Done."), U])
    h.create().send("Write the file.")
    await h.settled()
    await h.dispose()
    const spans = batches.flat()
    const turn = spans.find((span) => span.parentSpanId === null)
    // The turn's span was sent, and says how it ended as a class.
    expect(turn?.attributes["error.type"]).toBe("approval")
    expect(turn?.status).toEqual({ code: "error" })
    // Nothing of the path, in any span, attribute, event or status.
    const sent = JSON.stringify(spans)
    expect(sent).not.toContain("payroll-2026")
    expect(sent).not.toContain("salaries.csv")
  } finally {
    await h.dispose()
  }
})
