/**
 * Hooks and language-server diagnostics: what a user's configuration adds
 * around a tool call and at the end of a turn, without anything of it in
 * the frozen prefix. A before hook refuses a call, an after hook adds a note
 * to a result, a stop hook sends the model back a bounded number of times,
 * and what a language server says about an edit follows the edit's result.
 * Each hook that applied is a `hook.ran` event in the append of what it
 * decided.
 */
import { type DiagnosticsRecord, HARNESS_ORIGIN } from "../../src/event/durable.ts"
import { type HooksConfigSection, resolveHooksConfig } from "../../src/hooks/config.ts"
import { decideStop, noteText, refusalText } from "../../src/hooks/decide.ts"
import {
  type Scenario,
  called,
  executionSucceeded,
  hookRan,
  opening,
  ran,
  say,
  settled,
  settledDiagnosed,
  stepEnded,
  stepStarted,
  succeededUnsatisfied,
  synthetic,
  toolStarted,
} from "./script.ts"

// ---------------------------------------------------------------- a before hook

export const NO_PUSH_HOOKS: HooksConfigSection = { beforeTool: [{ name: "no-push", tools: ["shell"], command: "./hooks/no-push.sh" }] }
const NO_PUSH = resolveHooksConfig(NO_PUSH_HOOKS, undefined).beforeTool[0]!
export const PUSH_INPUT = '{"command":"git push origin main"}'
export const PUSH_REASON = "Pushing is not allowed here. Commit locally and tell the user."

export const beforeHookRefuses: Scenario = {
  title: "A before hook refuses a call, and the model reads why",
  description:
    "The user's configuration has a hook that runs before every `shell` call and refuses `git push`. The hook is asked after the call's arguments were accepted and before anything else is decided about it: no approval is looked at, no question is asked, nothing starts. The call settles from `pending` as an error whose text is the hook's reason, word for word, and the hook's record (`hook.ran`: which hook, how it ran, what it answered, the text that reached the model) is written right before that result, in the same append. A hook that does not object would have left the call to the approval layer unchanged: it approves nothing. Nothing about hooks is in the request's prefix: the model learns of the hook from the result of the call it refused.",
  provider: "step 1 finishes with a shell call `git push origin main`; the hook exits 2 with its reason on stdout; step 2 answers",
  features: { hooks: NO_PUSH_HOOKS },
  phases: [
    {
      label: "the model asks to push",
      events: [...opening("Commit and push."), stepStarted("a1"), called("a1", "call_1", "shell", PUSH_INPUT)],
      expect: { open: "a1" },
      rejects: [
        { event: hookRan({ ...NO_PUSH, point: "afterTool" }, ["a1", "call_1"], "no", "A note."), code: "invalid_transition", why: "an after hook applies to a call that ran, and this one never started" },
        { event: hookRan(NO_PUSH, ["a1", "call_9"], "yes"), code: "not_found", why: "a hook's record names a call of the open step" },
        { event: hookRan(NO_PUSH, null, "no", PUSH_REASON), code: "invalid_transition", why: "a hook that applies to a tool call names it" },
        { event: hookRan({ ...NO_PUSH, point: "stop" }, ["a1", "call_1"], "yes"), code: "invalid_transition", why: "a stop hook applies to the end of a turn, not to a call" },
        { event: hookRan(NO_PUSH, ["a1", "call_1"], "yes", "Looks fine."), code: "invalid_transition", why: "only a hook that answered no has text that reached the model" },
      ],
    },
    {
      label: "the hook refuses: its record and the call's result are one append, and the call never starts",
      events: [hookRan(NO_PUSH, ["a1", "call_1"], "no", PUSH_REASON), settled("a1", "call_1", "error", refusalText(NO_PUSH, PUSH_REASON)), stepEnded("a1", "tool_calls")],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell error"] }], open: null },
      rejects: [{ event: hookRan(NO_PUSH, ["a1", "call_1"], "yes"), code: "invalid_transition", why: "a hook's record comes before the result of its call, in the step that made the call" }],
    },
    {
      label: "the model tells the user",
      events: [stepStarted("a2"), say("a2", "I committed locally. Pushing is not allowed here."), stepEnded("a2"), executionSucceeded()],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "a2", status: "completed" }], history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

// ---------------------------------------------------------------- an after hook

export const FORMAT_HOOKS: HooksConfigSection = { afterTool: [{ name: "prettier", tools: ["write"], paths: ["**/*.ts"], command: "./hooks/format.sh" }] }
const FORMAT = resolveHooksConfig(FORMAT_HOOKS, undefined).afterTool[0]!
export const WRITE_HELPER = '{"path":"src/a.ts","content":"export const a = "}'
export const WROTE_HELPER = "Wrote src/a.ts (1 line)."
export const FORMAT_NOTE = "prettier could not format this file; run it to see why."

export const afterHookAddsANote: Scenario = {
  title: "An after hook adds a note to a result, stored once with it",
  description:
    "The user's configuration has a hook that runs after every `write` of a TypeScript file. The tool runs as always (`tool.started`, then the tool). After it returned and before its result is capped and stored, the hook is run with the result and answers with a note. The note is appended after the tool's own output, which stays first, byte for byte; the whole text is then capped once and stored once in `tool.settled`, and replayed as stored from then on. The hook's record is written right before the result, in the same append. A hook can only add: it cannot change the call's arguments, the tool's output, or a result that is already in the log.",
  provider: "step 1 finishes with a write call; the hook exits 2 with its note on stdout; step 2 answers",
  features: { hooks: FORMAT_HOOKS },
  phases: [
    {
      label: "the tool runs, then the hook: the result carries the tool's output and the note",
      events: [
        ...opening("Add the helper."),
        stepStarted("a1"),
        called("a1", "call_1", "write", WRITE_HELPER),
        toolStarted("a1", "call_1", "write"),
        hookRan(FORMAT, ["a1", "call_1"], "no", FORMAT_NOTE),
        settled("a1", "call_1", "success", `${WROTE_HELPER}${noteText(FORMAT, FORMAT_NOTE)}`),
        stepEnded("a1", "tool_calls"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write success"] }], open: null },
    },
    {
      label: "the model reads the note in the result and answers",
      events: [stepStarted("a2"), say("a2", "Written; the file does not parse yet."), stepEnded("a2"), executionSucceeded()],
      expect: { history: ["u1", "a1", "a2"], execution: null },
    },
  ],
}

// ---------------------------------------------------------------- a stop hook

export const SCRATCH_HOOKS: HooksConfigSection = { stop: [{ name: "no-scratch", command: "./hooks/no-scratch.sh" }], maxStopRounds: 1 }
const SCRATCH = resolveHooksConfig(SCRATCH_HOOKS, undefined).stop[0]!
export const SCRATCH_REASON = "SCRATCH.md still exists. Delete it before you finish."
const sentBack = decideStop({ verdicts: [{ hook: SCRATCH, answer: { kind: "no", text: SCRATCH_REASON, cut: false } }], roundsSent: 0, maxRounds: 1 })
if (sentBack.kind !== "continue") throw new Error("the first stop round sends the model back")
export const STOP_MESSAGE = sentBack.message

export const stopHookSendsBack: Scenario = {
  title: "A stop hook sends the model back, and at its bound the turn ends with the hook unsatisfied",
  description:
    "The user's configuration has a stop hook and allows it one round per turn (`maxStopRounds: 1`). When the model has answered and the verification gate says the turn may end, the stop hooks are asked. The hook objects: its message is appended as a harness message (origin `stop_hook`), with the hook's record, in one append, and the model is sent back, exactly as a check report sends it back. The message must be answered: the execution cannot end on it. When the model stops again the hook is asked again and still objects, but the turn has been sent back as often as it may be (the rounds are counted from the stop messages in the log, so a restart counts the same): the turn ends, and its ending says which hooks were not satisfied (`hooks.unsatisfied`) and what each of them said this last time (`hooks.objections`), next to what the gate found. The hook's second answer sent nobody back, so it reached the user and not the model: its record has no text for the model, and the ending is where a client reads the hook's words. A stop hook never loops, and one that cannot answer lets the turn end.",
  provider: "step 1 answers; the hook exits 2 with its message; step 2 answers; the hook exits 2 again",
  features: { hooks: SCRATCH_HOOKS },
  phases: [
    {
      label: "the model answers; the hook objects, and its message sends the model back",
      events: [...opening("Tidy up."), stepStarted("a1"), say("a1", "Done."), stepEnded("a1"), hookRan(SCRATCH, null, "no", SCRATCH_REASON), synthetic("s1", HARNESS_ORIGIN.stopHook, STOP_MESSAGE)],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "s1", kind: "synthetic", origin: "stop_hook" }], history: ["u1", "a1", "s1"], execution: { status: "running", crashResumes: 0 }, open: null },
      rejects: [{ event: executionSucceeded(), code: "invalid_transition", why: "the stop hook's message is unanswered: the model was sent back with it" }],
    },
    {
      label: "the model stops again",
      events: [stepStarted("a2"), say("a2", "I cannot delete SCRATCH.md: it is not mine to remove."), stepEnded("a2")],
      expect: { open: null },
      rejects: [
        { event: succeededUnsatisfied([]), code: "invalid_transition", why: "an ending names the stop hooks that were not satisfied only when there is one" },
        { event: succeededUnsatisfied(["no-scratch", "no-scratch"]), code: "invalid_transition", why: "an ending names each unsatisfied stop hook once" },
        { event: succeededUnsatisfied(["no-scratch"], SCRATCH_REASON, "exe_1", []), code: "invalid_transition", why: "an ending carries what each unsatisfied stop hook said" },
        { event: succeededUnsatisfied(["no-scratch"], SCRATCH_REASON, "exe_1", ["no-scratch", "another"]), code: "invalid_transition", why: "an ending carries the words of the unsatisfied stop hooks only" },
      ],
    },
    {
      label: "the hook still objects, at its bound: the turn ends and says so",
      events: [hookRan(SCRATCH, null, "no"), succeededUnsatisfied(["no-scratch"], SCRATCH_REASON)],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "s1" }, { id: "a2", status: "completed" }], history: ["u1", "a1", "s1", "a2"], execution: null },
      rejects: [{ event: hookRan(SCRATCH, null, "yes"), code: "invalid_transition", why: "a hook runs under an execution: there is none" }],
    },
  ],
}

// ---------------------------------------------------------------- diagnostics

/** The file of the scenario: a warning and an error the scripted server reports from the markers in the text. */
export const DOCUMENT_BEFORE = ["let unused = WARN(unused)", "call(ERROR(old))", "end"].join("\n")
export const DOCUMENT_AFTER = ["// a line added above", "let unused = WARN(unused)", "call(ERROR(old))", "fresh(ERROR(fetchUser))", "end"].join("\n")
export const READ_DOCUMENT = '{"path":"src/a.txt"}'
export const WRITE_DOCUMENT = JSON.stringify({ path: "src/a.txt", content: DOCUMENT_AFTER })
export const WROTE_DOCUMENT = "Wrote src/a.txt."
export const DIAGNOSTICS_NOTE = [
  `[Diagnostics from the language server "fixture" for src/a.txt after this edit: 1 new error]`,
  "src/a.txt:4:7: error E1: cannot find name 'fetchUser' (fixture)",
  "These are the language server's diagnostics for this file after the edit; the 1 it already had is not listed, and the project's checks remain the authority.",
].join("\n")
/** What the server said, as the result records it. The time waited and the fingerprint of the server's definition are stand-ins. */
const SAID: DiagnosticsRecord = {
  noteAdded: true,
  listed: 1,
  omitted: 0,
  waitedMs: 0,
  servers: [{ name: "fixture", origin: "user", fingerprint: "fingerprint", outcome: "compared", new: 1, preExisting: 1, fixed: 0 }],
}

export const editGetsDiagnostics: Scenario = {
  title: "A language server's diagnostics follow the result of the edit that made something worse",
  description:
    "The user's configuration names a language server for the files the model works on. When the model reads such a file the server is started in the background and shown the file; nothing waits for it. When the model then writes the file, the tool runs as always, and after it returned the server is asked what the edit made worse, for at most the configured wait. The edit adds a call to a name that does not exist: the server's one new error is appended to the tool's own output as a short note (the error the file already had is counted, not listed), before the result is capped and stored. What the server said is recorded with the result as fields (`diagnostics`: whether a note was added, how many diagnostics it lists, and per server whose configuration it is from, how it came out and the counts), never read back out of the text. The note gates nothing: the project's checks remain the authority, and a server that is slow, starting or gone adds nothing and costs at most the wait. Nothing about the server is in the request's prefix.",
  provider: "step 1 finishes with a read of `src/a.txt`; step 2 with a write of it that adds a call to an undefined name; step 3 answers",
  features: { lsp: true },
  phases: [
    {
      label: "the model reads the file: its result is the file, and the server is shown it in the background",
      events: [...opening("Call fetchUser."), stepStarted("a1"), ...ran("a1", "call_1", "read", READ_DOCUMENT, DOCUMENT_BEFORE), stepEnded("a1", "tool_calls")],
      expect: { history: ["u1", "a1"], open: null },
    },
    {
      label: "the model writes the file: the note follows the tool's own output, and the result records what the server said",
      events: [
        stepStarted("a2"),
        called("a2", "call_1", "write", WRITE_DOCUMENT),
        toolStarted("a2", "call_1", "write"),
        settledDiagnosed("a2", "call_1", `${WROTE_DOCUMENT}\n\n${DIAGNOSTICS_NOTE}`, SAID),
        stepEnded("a2", "tool_calls"),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1" }, { id: "a2", calls: ["call_1 write success"] }], open: null },
    },
    {
      label: "the model reads the note and answers",
      events: [stepStarted("a3"), say("a3", "Added the call; fetchUser is not defined yet."), stepEnded("a3"), executionSucceeded()],
      expect: { history: ["u1", "a1", "a2", "a3"], execution: null },
    },
  ],
}

export const hookScenarios: readonly Scenario[] = [beforeHookRefuses, afterHookAddsANote, stopHookSendsBack, editGetsDiagnostics]
