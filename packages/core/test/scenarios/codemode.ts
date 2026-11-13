/**
 * Code mode: the model writes a program (`run_code`) whose calls are calls
 * of the step, nested under the program's own call. Each is recorded,
 * decided and settled like a call of the model's; the model is shown the
 * program's call and its result, never the calls it made; and the
 * program's call settles after every one of them, also when recovery
 * settles them after a crash.
 */
import {
  CRASH_EFFECT_UNKNOWN,
  type Scenario,
  called,
  calledBy,
  executionResumed,
  executionSucceeded,
  interruptMarker,
  opening,
  say,
  settled,
  stepCrashed,
  stepEnded,
  stepStarted,
  toolStarted,
  toolStartedAs,
} from "./script.ts"

/** A program as the model writes it: the call's arguments, as JSON text. */
export const JOIN_PROGRAM = `const a = await read({ path: "a.ts" })\nconst b = await read({ path: "b.ts" })\nawait write({ path: "c.ts", content: a + b })\nconsole.log("joined", (a + b).length, "characters")`
export const JOINED = "joined 6 characters\n"
const joinInput = JSON.stringify({ code: JOIN_PROGRAM })

export const programCallsAreCallsOfTheStep: Scenario = {
  title: "A program's calls are calls of the step, nested under the program's call",
  description:
    "The model writes one program instead of three calls: it reads two files and writes a third. The program's call starts like any (it needs no question of its own: it can change nothing by itself), and each call the program makes is recorded with `parent`, the program's call, before anything about it is decided; it is then started and settled like a call of the model's, by the same approval layer, schedule and runtime. The program's call settles last, with what the program printed. The next request shows the model the program's call and its result, and nothing of the three calls it made. A call is nested only under a program's call that is running, one level deep, and the program's call cannot settle while one of its calls has no result.",
  provider: "step 1 calls run_code with a program that reads a.ts and b.ts and writes c.ts; step 2 answers",
  features: { codeMode: true },
  phases: [
    {
      label: "the program runs and makes its calls",
      events: [
        ...opening("Join a.ts and b.ts into c.ts."),
        stepStarted("a1"),
        called("a1", "call_1", "run_code", joinInput),
        toolStartedAs("a1", "call_1", "exec"),
        calledBy("a1", "call_1", "call_1.1", "read", '{"path":"a.ts"}'),
        toolStarted("a1", "call_1.1", "read"),
        settled("a1", "call_1.1", "success", "aaa"),
        calledBy("a1", "call_1", "call_1.2", "read", '{"path":"b.ts"}'),
        toolStarted("a1", "call_1.2", "read"),
        settled("a1", "call_1.2", "success", "bbb"),
        calledBy("a1", "call_1", "call_1.3", "write", '{"path":"c.ts","content":"aaabbb"}'),
        toolStarted("a1", "call_1.3", "write"),
      ],
      expect: {
        open: "a1",
        ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 run_code running", "call_1.1 read success (by call_1)", "call_1.2 read success (by call_1)", "call_1.3 write running (by call_1)"] }],
      },
      rejects: [
        { event: settled("a1", "call_1", "success", JOINED), code: "invalid_transition", why: "a program's call settles after every call it made, and call_1.3 has no result" },
        { event: calledBy("a1", "call_7", "call_7.1", "read", '{"path":"a.ts"}'), code: "not_found", why: "a call is nested under a call of the step" },
        { event: calledBy("a1", "call_1.1", "call_1.1.1", "read", '{"path":"a.ts"}'), code: "invalid_transition", why: "a program's calls are not nested further: one level of programs" },
      ],
    },
    {
      label: "the write is done, then the program; the model reads the program's result",
      events: [
        settled("a1", "call_1.3", "success", "Wrote c.ts"),
        settled("a1", "call_1", "success", JOINED),
        stepEnded("a1", "tool_calls"),
        stepStarted("a2"),
        say("a2", "c.ts now holds both files: 6 characters."),
        stepEnded("a2"),
        executionSucceeded(),
      ],
      expect: {
        execution: null,
        open: null,
        ui: [
          { id: "u1" },
          { id: "a1", status: "completed", calls: ["call_1 run_code success", "call_1.1 read success (by call_1)", "call_1.2 read success (by call_1)", "call_1.3 write success (by call_1)"] },
          { id: "a2", status: "completed" },
        ],
        history: ["u1", "a1", "a2"],
      },
      rejects: [{ event: calledBy("a1", "call_1", "call_1.4", "read", '{"path":"a.ts"}'), code: "invalid_transition", why: "a program makes its calls while its call runs, within the open step" }],
    },
  ],
}

export const FIX_PROGRAM = `await write({ path: "a.ts", content: "fixed" })\nawait shell({ command: "bun test" })`
const fixInput = JSON.stringify({ code: FIX_PROGRAM })

export const crashInsideProgram: Scenario = {
  title: "The process dies while a program's command runs",
  description:
    "A program wrote a file and then started the tests, and the process died while they ran. At the next start recovery settles the calls of the open step from what the log says, the program's calls first: the command started and nobody saw it finish, so it is `effect_unknown`; then the program's own call, which had started too. Nothing is run again: the resumed step tells the model that the program was cut off, and the model looks before repeating anything. The write that had its result keeps it.",
  provider: "step 1 calls run_code with a program that writes a.ts and runs the tests, which never return; the process is killed; after restart the model answers",
  features: { codeMode: true },
  phases: [
    {
      label: "the process dies while the program's command runs",
      events: [
        ...opening("Fix a.ts and run the tests."),
        stepStarted("a1"),
        called("a1", "call_1", "run_code", fixInput),
        toolStartedAs("a1", "call_1", "exec"),
        calledBy("a1", "call_1", "call_1.1", "write", '{"path":"a.ts","content":"fixed"}'),
        toolStarted("a1", "call_1.1", "write"),
        settled("a1", "call_1.1", "success", "Wrote a.ts"),
        calledBy("a1", "call_1", "call_1.2", "shell", '{"command":"bun test"}'),
        toolStarted("a1", "call_1.2", "shell"),
      ],
      expect: { execution: { status: "running", crashResumes: 0 }, ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 run_code running", "call_1.1 write success (by call_1)", "call_1.2 shell running (by call_1)"] }] },
    },
    {
      label: "at next start-up the program's calls are settled first, then the program's",
      events: [
        settled("a1", "call_1.2", "effect_unknown", CRASH_EFFECT_UNKNOWN),
        settled("a1", "call_1", "effect_unknown", CRASH_EFFECT_UNKNOWN),
        stepCrashed("a1"),
        interruptMarker("s1", "crash"),
        executionResumed(),
      ],
      expect: {
        ui: [
          { id: "u1" },
          { id: "a1", status: "failed", error: "crashed", calls: ["call_1 run_code effect_unknown", "call_1.1 write success (by call_1)", "call_1.2 shell effect_unknown (by call_1)"] },
          { id: "s1" },
        ],
        history: ["u1", "a1", "s1"],
        execution: { status: "running", crashResumes: 1 },
      },
    },
    {
      label: "the model looks before repeating",
      events: [stepStarted("a2"), say("a2", "The program was cut off while the tests ran; a.ts was written. I will run the tests again to see where they stand."), stepEnded("a2"), executionSucceeded()],
      expect: { execution: null, open: null, ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "crashed", calls: ["call_1 run_code effect_unknown", "call_1.1 write success (by call_1)", "call_1.2 shell effect_unknown (by call_1)"] }, { id: "s1" }, { id: "a2", status: "completed" }], history: ["u1", "a1", "s1", "a2"] },
    },
  ],
}

export const codeModeScenarios = [programCallsAreCallsOfTheStep, crashInsideProgram]
