/**
 * How the model says it cannot make a failing check pass: a dedicated tool
 * call, never a phrase in its prose. The call's input is validated like any
 * tool input, so whether the model acknowledged a failure, and which checks it
 * named, is a fact read from a settled tool call rather than a guess about
 * what a sentence means. "I could not get the tests to pass" and "the tests
 * pass now" differ by a few words; a tool call cannot be misread that way.
 *
 * The tool's name, description and schema are fixed: they do not list the
 * configured check names, so the frozen tool list (and the cached prefix) does
 * not change when the configuration does. The step loop puts it in a session's
 * frozen tool list when verification is not off as the first baseline is set
 * (whether or not a check is configured yet), and the list keeps it from then on.
 *
 * The step loop passes the gate the input of the latest call to this tool made
 * after the latest check report was delivered, or `null`. A call made before
 * the checks it names last ran acknowledges nothing.
 */
import type { Tool } from "../tool/tool.ts"
import { type Infer, array, nonEmptyString, object } from "../validate.ts"

export const ACKNOWLEDGE_TOOL_NAME = "report_check_failure"

export const acknowledgement = object({ checks: array(nonEmptyString), reason: nonEmptyString })
export type Acknowledgement = Infer<typeof acknowledgement>

export function acknowledgeTool(): Tool<Acknowledgement> {
  return {
    name: ACKNOWLEDGE_TOOL_NAME,
    description:
      "Report that checks run by the harness fail and that you cannot make them pass. Use it only after a check report, naming every failing check, with the reason (for example a broken check command, a missing dependency, or a failure outside the task). The turn then ends with the failure recorded as unresolved.",
    inputSchema: {
      type: "object",
      properties: {
        checks: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, description: "The names of the failing checks, as shown in the report." },
        reason: { type: "string", minLength: 1, description: "Why they cannot pass." },
      },
      required: ["checks", "reason"],
      additionalProperties: false,
    },
    effect: "read",
    execute: async (input) => ({
      status: "success",
      output: `Recorded as unresolved: ${input.checks.join(", ")}.`,
      truncation: null,
      attachments: [],
      display: null,
    }),
  }
}
