/**
 * Review finding: with `content` off, the span of a turn that failed still carries the failure's sentence,
 * and that sentence can name a file path.
 *
 * What is promised.
 * - docs/telemetry.md, opening: "by default it sends no text of yours: no prompt, no answer, no file path, no
 *   command."
 * - docs/telemetry.md, "Content is off by default": "Without `content` the attributes are names, numbers,
 *   classes and outcomes: tool names, token counts, durations, how a call ended."
 *
 * What happens. `mapSession` puts the message of `execution.failed` into the turn span's status
 * (`span.status = { code: "error", message: ... }`) whether or not content is exported, and the live window
 * (`kept` in packages/core/src/engine/telemetry.ts) strips arguments, output and prompts but passes
 * `execution.failed` through whole. Those messages are sentences built from the session: with
 * `unattended: "stop"` the message quotes the refusal ("... needs the user's approval for writing <path>", or
 * "this command writing to <directory>", or the name of an MCP server's tool); a configuration error names the
 * configuration file's path and the offending key; a harness failure carries an error's text. All of it is
 * sent to the collector with content off. (It is redacted and cut at 4,096 characters, which does not make a
 * path a class or an outcome.) The same holds for the export after the fact, which uses the same mapping.
 *
 * Code path. packages/core/src/telemetry/map.ts, `mapSession`, case `execution.failed`; the model call's span
 * does the same with a provider error's message further down (`span.status = ... text(error.message)`).
 *
 * Smallest fix. In `mapSession`, set the status message only when `content` is true; without it the span keeps
 * `error.type` (the cause, already a class) and `status.code`.
 *
 * What that fix could affect. A trace of a failed turn no longer says why in words unless content is on;
 * `error.type` is `failed` for most causes, so it may be worth giving `execution.failed` more causes.
 * `test/engine/telemetry.test.ts` compares live spans with the export after the fact; both change together.
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

test.failing("with content off, no file path should reach the collector, also when the turn fails", async () => {
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
    expect(turn?.status.code).toBe("error")
    // Nothing of the path, in any span, attribute, event or status.
    const sent = JSON.stringify(spans)
    expect(sent).not.toContain("payroll-2026")
    expect(sent).not.toContain("salaries.csv")
  } finally {
    await h.dispose()
  }
})
