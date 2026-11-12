/**
 * Demo scenarios owned by the CLI. The core scenarios exercise every control
 * path but carry no `display` data and no realistic output; these two show
 * what a real session looks like: searches, a failing command, an edit with a
 * diff, parallel calls, usage on every step, and output capped to a spill file.
 */
import { type Json, type NewEvent, type ToolEffect, type Truncation, brand, event } from "@light-harness/core"
import {
  type Scenario,
  c,
  executionSucceeded,
  m,
  opening,
  say,
  stepStarted,
  think,
} from "@light-harness/core/testing/scenarios"

const EFFECTS: Record<string, ToolEffect> = { read: "read", grep: "read", glob: "read", ls: "read", edit: "write", write: "write", shell: "exec" }

const called = (id: string, callId: string, name: string, input: Record<string, Json>) =>
  event("tool.called", { messageId: m(id), callId: c(callId), name, input: JSON.stringify(input), providerData: null })

const toolStarted = (id: string, callId: string, name: string) => event("tool.started", { messageId: m(id), callId: c(callId), effect: EFFECTS[name] ?? "exec" })

const settled = (
  id: string,
  callId: string,
  outcome: "success" | "error",
  output: string,
  display: Json,
  truncation: Truncation | null = null,
) => event("tool.settled", { messageId: m(id), callId: c(callId), outcome, output, truncation, attachments: [], display })

const ended = (id: string, finish: "stop" | "tool_calls", input: number, cached: number, output: number, reasoning = 0): NewEvent =>
  event("step.ended", {
    messageId: m(id),
    finish,
    usage: { inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningTokens: reasoning },
  })

const FAILING_RUN = [
  "bun test v1.4.0",
  "",
  "src/add.test.ts:",
  "✗ add > adds two numbers [0.31ms]",
  "  error: expect(received).toBe(expected)",
  "  Expected: 3",
  "  Received: -1",
  "",
  " 0 pass",
  " 1 fail",
  "[Exit code 1]",
].join("\n")

const PASSING_RUN = ["bun test v1.4.0", "", "src/add.test.ts:", "✓ add > adds two numbers [0.12ms]", "", " 1 pass", " 0 fail"].join("\n")

const DIFF = [
  "--- a/src/add.ts",
  "+++ b/src/add.ts",
  "@@ -1,3 +1,3 @@",
  " export function add(a: number, b: number) {",
  "-  return a - b",
  "+  return a + b",
  " }",
].join("\n")

export const fixFailingTest: Scenario = {
  title: "Find and fix a failing test",
  description: "A realistic multi-step turn: search and run the test in parallel, read the source, edit it, rerun the test, answer.",
  provider: "five steps; the first makes two parallel calls that settle out of order",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening("The add test is failing. Find out why and fix it."),
        stepStarted("a1"),
        think("a1", "**Locating the test**\n\nI should find where `add` is defined and tested, and run the failing test to see the error."),
        say("a1", "I'll find the code and run the failing test."),
        called("a1", "call_1", "grep", { pattern: "add\\(", path: "src" }),
        called("a1", "call_2", "shell", { command: "bun test src/add.test.ts" }),
        toolStarted("a1", "call_1", "grep"),
        toolStarted("a1", "call_2", "shell"),
        settled(
          "a1",
          "call_1",
          "success",
          "src/add.ts:1:export function add(a: number, b: number) {\nsrc/add.test.ts:4:  expect(add(1, 2)).toBe(3)\nsrc/add.test.ts:5:  expect(add(0, 0)).toBe(0)\nsrc/index.ts:3:export { add } from \"./add.ts\"",
          { matches: 4, files: 3, engine: "ripgrep" },
        ),
        settled("a1", "call_2", "error", FAILING_RUN, { exitCode: 1, signal: null, timedOut: false, interrupted: null, durationMs: 612 }),
        ended("a1", "tool_calls", 8_214, 0, 196, 64),
        stepStarted("a2"),
        called("a2", "call_1", "read", { path: "src/add.ts" }),
        toolStarted("a2", "call_1", "read"),
        settled("a2", "call_1", "success", "1\texport function add(a: number, b: number) {\n2\t  return a - b\n3\t}", { path: "src/add.ts", offset: 1, lines: 3, totalLines: 3 }),
        ended("a2", "tool_calls", 8_870, 8_192, 41),
        stepStarted("a3"),
        say("a3", "`add` subtracts instead of adding. Fixing it."),
        called("a3", "call_1", "edit", { path: "src/add.ts", old_string: "  return a - b", new_string: "  return a + b" }),
        toolStarted("a3", "call_1", "edit"),
        settled("a3", "call_1", "success", "Edited src/add.ts: replaced 1 occurrence (line 2).", { path: "src/add.ts", replacements: 1, diff: DIFF }),
        ended("a3", "tool_calls", 9_012, 8_704, 77),
        stepStarted("a4"),
        called("a4", "call_1", "shell", { command: "bun test src/add.test.ts" }),
        toolStarted("a4", "call_1", "shell"),
        settled("a4", "call_1", "success", PASSING_RUN, { exitCode: 0, signal: null, timedOut: false, interrupted: null, durationMs: 540 }),
        ended("a4", "tool_calls", 9_240, 8_960, 30),
        stepStarted("a5"),
        say(
          "a5",
          "Fixed. `add` in `src/add.ts` returned `a - b`; it now returns `a + b`.\n\n`bun test src/add.test.ts` passes (1 pass, 0 fail).",
        ),
        ended("a5", "stop", 9_410, 9_216, 52),
        executionSucceeded(),
      ],
      expect: { execution: null },
    },
  ],
}

const BUILD_OUTPUT = [
  "$ tsc -p tsconfig.build.json",
  "$ bun build src/index.ts --outdir dist",
  "  dist/index.js  412.08 KB",
  "$ bun test",
  "bun test v1.4.0",
  "src/a.test.ts: 18 pass",
  "src/b.test.ts: 41 pass",
  "src/c.test.ts: 27 pass",
  "src/d.test.ts: 52 pass",
  "src/e.test.ts: 33 pass",
  "src/f.test.ts: 43 pass",
  "",
  " 214 pass",
  " 0 fail",
  "Ran 214 tests across 6 files. [4.81s]",
  "",
  `[Output capped: 4,210 lines in total. The full output is in /tmp/${brand.binary}-spill/shell-a1-call_1.log]`,
].join("\n")

export const longBuild: Scenario = {
  title: "A long build command",
  description: "One long-running command that streams progress and whose output is capped to a spill file. Press Ctrl-C while it runs to see a cancel.",
  provider: "step 1 runs one shell call for several seconds; step 2 answers",
  phases: [
    {
      label: "the turn",
      events: [
        ...opening("Run the full build and the tests, and tell me if they pass."),
        stepStarted("a1"),
        say("a1", "Running the build and the test suite."),
        called("a1", "call_1", "shell", { command: "bun run build && bun test" }),
        toolStarted("a1", "call_1", "shell"),
        settled(
          "a1",
          "call_1",
          "success",
          BUILD_OUTPUT,
          { exitCode: 0, signal: null, timedOut: false, interrupted: null, durationMs: 9_420 },
          { originalBytes: 312_044, originalLines: 4_210, spillPath: `/tmp/${brand.binary}-spill/shell-a1-call_1.log` },
        ),
        ended("a1", "tool_calls", 6_100, 0, 38),
        stepStarted("a2"),
        say("a2", "The build succeeds and all 214 tests pass."),
        ended("a2", "stop", 7_350, 6_016, 21),
        executionSucceeded(),
      ],
      expect: { execution: null },
    },
  ],
}

export const showcase = [fixFailingTest, longBuild]
