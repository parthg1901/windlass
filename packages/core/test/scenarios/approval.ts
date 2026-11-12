/**
 * Approval and the sandbox: what the loop writes when a call runs under the
 * approval layer, is asked about, or is refused. In every other family the
 * layer is off; here each scenario says what it runs under (`approval`).
 */
import {
  type Asked,
  type Scenario,
  DECLINED,
  NETWORK_HINT,
  NOT_STARTED,
  NO_SANDBOX,
  SANDBOXED,
  WITH_NETWORK,
  approvalAnswered,
  approvalDenied,
  approvalRequested,
  called,
  escalate,
  executionInterrupted,
  executionResumed,
  executionStopped,
  executionSucceeded,
  interruptMarker,
  interruptRequested,
  opening,
  ranUnder,
  refusal,
  say,
  settled,
  settledWith,
  startedAs,
  stepCrashed,
  stepEnded,
  stepInterrupted,
  stepStarted,
  taintNoticed,
  taintedBy,
} from "./script.ts"

const CURL = "curl -s https://example.com/notes"
const withNetwork = (command: string) => JSON.stringify({ command, sandbox: { network: true } })
const plain = (command: string) => JSON.stringify({ command })
/** The model's explicit request for the network on a command. */
const fetching = (command: string, more: Partial<Asked> = {}): Asked => ({ name: "shell", command, escalation: escalate(true), ...more })
/** The answer that ends a turn. */
const answer = (id: string, value: string) => [stepStarted(id), say(id, value), stepEnded(id), executionSucceeded()]

export const autoWithSandbox: Scenario = {
  title: "Auto mode: an edit runs and a command runs in the sandbox",
  description:
    "The default. An edit inside the workspace runs as it is and a command runs in the sandbox (no network, writes only in the workspace and the temp directory), and nobody is asked. `tool.started` records what each ran under: the mode, the path facts the decision was made from, and for the command that it was sandboxed and with what. The command is decided and started only once the edit before it has its result: what can change something runs one at a time, in the order the model wrote it.",
  provider: "asks for a write and a command in one response, then answers",
  approval: {},
  phases: [
    {
      label: "the edit runs, then the command, sandboxed",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "write", '{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}'),
        called("a1", "call_2", "shell", plain("bun test")),
        startedAs("a1", "call_1", "write", ranUnder("auto", ["a.test.ts"])),
        settled("a1", "call_1", "success", "written"),
        startedAs("a1", "call_2", "shell", ranUnder("auto", [], SANDBOXED)),
        settled("a1", "call_2", "success", "1 pass"),
        stepEnded("a1", "tool_calls"),
        ...answer("a2", "Fixed: the test passes."),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write success", "call_2 shell success"] }, { id: "a2", text: "Fixed: the test passes." }],
        history: ["u1", "a1", "a2"],
        execution: null,
      },
    },
  ],
}

export const networkEscalation: Scenario = {
  title: "A command needs the network: the hint, the request, one approval, taint, and the next request asks again",
  description:
    "A sandboxed command fails because it has no network, and its result ends with the note that says how to ask. The model runs it again with `sandbox: { network: true }`: the harness never widens the sandbox on its own, and never guesses from the error. The user is asked, allows it once, and the command runs in the sandbox with the network on. Its output is now content from outside, so the session is tainted and the user is told, once. The next request for the network asks again, and the question says why earlier approvals no longer count.",
  provider: "runs curl, runs it again asking for the network, asks for the network once more, then answers",
  approval: { attended: true },
  phases: [
    {
      label: "the command fails in the sandbox and the result carries the hint",
      events: [
        ...opening("Summarise the release notes at example.com."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", plain(CURL)),
        startedAs("a1", "call_1", "shell", ranUnder("auto", [], SANDBOXED)),
        settledWith("a1", "call_1", "error", `curl: (6) Could not resolve host: example.com\n[Exit code 6]\n${NETWORK_HINT}`, { exitCode: 6 }),
        stepEnded("a1", "tool_calls"),
      ],
    },
    {
      label: "the model asks for the network and the user is asked",
      events: [stepStarted("a2"), called("a2", "call_1", "shell", withNetwork(CURL)), approvalRequested("a2", "call_1", fetching(CURL))],
      expect: { open: "a2", ui: [{ id: "u1" }, { id: "a1" }, { id: "a2", calls: ["call_1 shell pending"] }], execution: { status: "running", crashResumes: 0 } },
      rejects: [
        { event: startedAs("a2", "call_1", "shell", ranUnder("auto", [], WITH_NETWORK)), code: "invalid_transition", why: "a call the user was asked about starts only once they approved" },
        { event: approvalRequested("a2", "call_1", fetching(CURL)), code: "invalid_transition", why: "a call is asked about once" },
        { event: approvalAnswered("a2", "call_1", { name: "shell", command: CURL, mode: "ask" }, "session", 14), code: "invalid_transition", why: "an answer records exactly what the chosen choice of the question remembers" },
      ],
    },
    {
      label: "the user allows it once: it runs with the network, and the session is tainted",
      events: [
        approvalAnswered("a2", "call_1", fetching(CURL), "once", 14),
        startedAs("a2", "call_1", "shell", ranUnder("auto", [], WITH_NETWORK)),
        settled("a2", "call_1", "success", "v2.1: faster installs"),
        taintNoticed({ at: 16, tool: "shell", kind: "network-command", path: null }),
        stepEnded("a2", "tool_calls"),
      ],
      rejects: [
        { event: taintNoticed({ at: 16, tool: "shell", kind: "network-command", path: null }), code: "invalid_transition", why: "the user is told once that the session is tainted" },
        { event: approvalAnswered("a2", "call_1", fetching(CURL), "once", 19), code: "invalid_transition", why: "a question is answered once" },
      ],
    },
    {
      label: "the next request for the network asks again, and this time the user says no",
      events: [
        stepStarted("a3"),
        called("a3", "call_1", "shell", withNetwork("curl -s https://example.com/next")),
        approvalRequested("a3", "call_1", fetching("curl -s https://example.com/next", { taint: taintedBy({ at: 16, tool: "shell", kind: "network-command", path: null }) })),
        approvalAnswered("a3", "call_1", fetching("curl -s https://example.com/next", { taint: taintedBy({ at: 16, tool: "shell", kind: "network-command", path: null }) }), "deny", 22),
        settled("a3", "call_1", "error", DECLINED),
        stepEnded("a3", "tool_calls"),
        ...answer("a4", "The notes say installs are faster."),
      ],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell error"] }, { id: "a2", calls: ["call_1 shell success"] }, { id: "a3", calls: ["call_1 shell error"] }, { id: "a4" }],
        history: ["u1", "a1", "a2", "a3", "a4"],
        execution: null,
      },
    },
  ],
}

const EDIT = '{"path":"a.test.ts","content":"expect(add(1, 1)).toBe(2)"}'

export const askMode: Scenario = {
  title: "Ask mode: a read runs, an edit and a command each ask",
  description:
    "In `ask` a read runs and everything else is asked about first: the edit, with the real path it would write, and the command, which still runs in the sandbox once approved. Each question is durable before it is put, with its choices and what each would remember, and the answer is recorded before the call starts.",
  provider: "reads the test, writes it, runs the tests, then answers",
  approval: { mode: "ask", attended: true },
  phases: [
    {
      label: "the read runs without a question",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "read", '{"path":"a.test.ts"}'),
        startedAs("a1", "call_1", "read", ranUnder("ask", ["a.test.ts"])),
        settled("a1", "call_1", "success", "expect(add(1, 1)).toBe(3)"),
        stepEnded("a1", "tool_calls"),
      ],
    },
    {
      label: "the edit asks and is allowed once",
      events: [
        stepStarted("a2"),
        called("a2", "call_1", "write", EDIT),
        approvalRequested("a2", "call_1", { mode: "ask", name: "write", paths: ["a.test.ts"] }),
        approvalAnswered("a2", "call_1", { mode: "ask", name: "write", paths: ["a.test.ts"] }, "once", 14),
        startedAs("a2", "call_1", "write", ranUnder("ask", ["a.test.ts"])),
        settled("a2", "call_1", "success", "written"),
        stepEnded("a2", "tool_calls"),
      ],
    },
    {
      label: "the command asks and runs in the sandbox",
      events: [
        stepStarted("a3"),
        called("a3", "call_1", "shell", plain("bun test")),
        approvalRequested("a3", "call_1", { mode: "ask", name: "shell", command: "bun test" }),
        approvalAnswered("a3", "call_1", { mode: "ask", name: "shell", command: "bun test" }, "once", 21),
        startedAs("a3", "call_1", "shell", ranUnder("ask", [], SANDBOXED)),
        settled("a3", "call_1", "success", "1 pass"),
        stepEnded("a3", "tool_calls"),
        ...answer("a4", "Fixed: the test passes."),
      ],
      expect: { history: ["u1", "a1", "a2", "a3", "a4"], execution: null },
    },
  ],
}

const KEYS: Asked = { name: "write", paths: ["~/.ssh/authorized_keys"] }

export const policyDenial: Scenario = {
  title: "A call the policy refuses",
  description:
    "The model tries to write into a credential store. No mode but `full` allows that and nobody is asked: the call is refused, and the refusal (with the real path, links followed) is the call's result. The denial and the result are one append, so a log never holds a denied call without what the model was told.",
  provider: "asks to write ~/.ssh/authorized_keys, then answers",
  approval: {},
  phases: [
    {
      label: "the write is refused",
      events: [
        ...opening("Add my key to the server."),
        stepStarted("a1"),
        called("a1", "call_1", "write", '{"path":"~/.ssh/authorized_keys","content":"ssh-ed25519 AAAA"}'),
        approvalDenied("a1", "call_1", KEYS, "policy"),
        settled("a1", "call_1", "error", refusal(KEYS)),
        stepEnded("a1", "tool_calls"),
        ...answer("a2", "I cannot change that file."),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 write error"] }, { id: "a2" }], history: ["u1", "a1", "a2"], execution: null },
      rejects: [],
    },
  ],
}

export const unattendedDeny: Scenario = {
  title: "Nobody present: a call that would ask is refused and the run goes on",
  description:
    "A one-shot run, `--json`, an eval: nobody can answer. A call that would ask is refused at once with what it needed, the model is told, and the run goes on. Nothing waits, and no setting turns the question into a yes.",
  provider: "asks for the network on a command, then answers",
  approval: {},
  phases: [
    {
      label: "the call is refused with the reason",
      events: [
        ...opening("Summarise the release notes at example.com."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", withNetwork(CURL)),
        approvalDenied("a1", "call_1", fetching(CURL), "unattended"),
        settled("a1", "call_1", "error", refusal(fetching(CURL))),
        stepEnded("a1", "tool_calls"),
        ...answer("a2", "I could not reach example.com: this run has no network."),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell error"] }, { id: "a2" }], execution: null },
      rejects: [],
    },
  ],
}

export const unattendedStop: Scenario = {
  title: "Nobody present, and the run ends with the refusal",
  description:
    "With the unattended behaviour `stop` a refusal for lack of an answer ends the run, for a run in which a refusal would hide a problem. The call is refused, what had not started does not start, the step closes and the execution ends with the cause `approval`, in one append.",
  provider: "asks for the network on a command and for a write in one response",
  approval: { unattended: "stop" },
  phases: [
    {
      label: "the command is refused, the write behind it never starts, and the run ends",
      events: [
        ...opening("Summarise the release notes at example.com."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", withNetwork(CURL)),
        called("a1", "call_2", "write", '{"path":"notes.md","content":"notes"}'),
        approvalDenied("a1", "call_1", fetching(CURL), "unattended", true),
        settled("a1", "call_1", "error", refusal(fetching(CURL))),
        settled("a1", "call_2", "not_started", NOT_STARTED),
        stepEnded("a1", "tool_calls"),
        executionStopped(refusal(fetching(CURL))),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell error", "call_2 write not_started"] }], execution: null },
    },
  ],
}

const TESTS: Asked = { mode: "ask", name: "shell", command: "bun test" }

export const rememberedApproval: Scenario = {
  title: "An approval remembered for the session, then used",
  description:
    "The user allows commands in the sandbox for the rest of the session. What is remembered is that capability, never the command: the answer records it, stamped with its own position in the log, and the next command, a different one, runs on it without a question.",
  provider: "runs the tests, runs the linter, then answers",
  approval: { mode: "ask", attended: true },
  phases: [
    {
      label: "the first command asks and the user allows commands for the session",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "shell", plain("bun test")),
        approvalRequested("a1", "call_1", TESTS),
        approvalAnswered("a1", "call_1", TESTS, "session", 9),
        startedAs("a1", "call_1", "shell", ranUnder("ask", [], SANDBOXED)),
        settled("a1", "call_1", "success", "1 pass"),
        stepEnded("a1", "tool_calls"),
      ],
    },
    {
      label: "the next command runs on what was remembered",
      events: [
        stepStarted("a2"),
        called("a2", "call_1", "shell", plain("bun run lint")),
        startedAs("a2", "call_1", "shell", ranUnder("ask", [], SANDBOXED)),
        settled("a2", "call_1", "success", "clean"),
        stepEnded("a2", "tool_calls"),
        ...answer("a3", "The tests pass and the linter is clean."),
      ],
      expect: { history: ["u1", "a1", "a2", "a3"], execution: null },
    },
  ],
}

export const questionInterrupted: Scenario = {
  title: "A pending question is interrupted",
  description:
    "While the question waits the turn is not stuck: the user can stop it. The interrupt withdraws the question, and the call settles as not started, like every call an interrupt reaches before it began. An answer that arrives afterwards is not taken.",
  provider: "asks for the network on a command",
  approval: { attended: true },
  phases: [
    {
      label: "the user is asked",
      events: [
        ...opening("Summarise the release notes at example.com."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", withNetwork(CURL)),
        approvalRequested("a1", "call_1", fetching(CURL)),
      ],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0 } },
    },
    {
      label: "the user stops the turn instead of answering",
      events: [interruptRequested("user")],
      rejects: [{ event: approvalAnswered("a1", "call_1", fetching(CURL), "once", 10), code: "invalid_transition", why: "once an interrupt is requested the execution only winds down: the question is withdrawn" }],
    },
    {
      label: "the call never started, and the execution ends as interrupted",
      events: [settled("a1", "call_1", "not_started", NOT_STARTED), stepInterrupted("a1", "user", "tools"), interruptMarker("s1", "user"), executionInterrupted("user")],
      expect: {
        ui: [{ id: "u1" }, { id: "a1", status: "failed", error: "interrupted:user", calls: ["call_1 shell not_started"] }, { id: "s1", origin: "interrupt" }],
        history: ["u1", "a1", "s1"],
        execution: null,
      },
    },
  ],
}

export const questionCrashed: Scenario = {
  title: "A crash with a pending question",
  description:
    "The process dies while a question waits. The call is pending in the log: it was asked about and never started. Recovery settles it as not started and closes the step as crashed, like any step a process died in. The model asks again, and so the user is asked again: an answer nobody recorded was never given.",
  provider: "asks for the network on a command; after the restart asks again, then answers",
  approval: { attended: true },
  phases: [
    {
      label: "the user is asked, and the process dies",
      events: [
        ...opening("Summarise the release notes at example.com."),
        stepStarted("a1"),
        called("a1", "call_1", "shell", withNetwork(CURL)),
        approvalRequested("a1", "call_1", fetching(CURL)),
      ],
      expect: { open: "a1", execution: { status: "running", crashResumes: 0 } },
    },
    {
      label: "at the next start-up the call is settled as not started and the claim resumed",
      events: [settled("a1", "call_1", "not_started", NOT_STARTED), stepCrashed("a1"), interruptMarker("s1", "crash"), executionResumed()],
      expect: { open: null, execution: { status: "running", crashResumes: 1 } },
    },
    {
      label: "the model asks again, the user is asked again and allows it",
      events: [
        stepStarted("a2"),
        called("a2", "call_1", "shell", withNetwork(CURL)),
        approvalRequested("a2", "call_1", fetching(CURL)),
        approvalAnswered("a2", "call_1", fetching(CURL), "once", 16),
        startedAs("a2", "call_1", "shell", ranUnder("auto", [], WITH_NETWORK)),
        settled("a2", "call_1", "success", "v2.1: faster installs"),
        taintNoticed({ at: 18, tool: "shell", kind: "network-command", path: null }),
        stepEnded("a2", "tool_calls"),
        ...answer("a3", "The notes say installs are faster."),
      ],
      expect: { history: ["u1", "a1", "s1", "a2", "a3"], execution: null },
    },
  ],
}

const UNSANDBOXED: Asked = { name: "shell", command: "bun test", sandbox: { available: false, reason: NO_SANDBOX } }

export const noSandbox: Scenario = {
  title: "No sandbox on this machine: auto asks for every command",
  description:
    "Where commands cannot be sandboxed, `auto` does not quietly become `full`: each command asks, the question says why the sandbox is missing and what running without it means, and what could be remembered is commands without the sandbox for this session, nothing wider. `tool.started` records that the command ran unsandboxed.",
  provider: "runs the tests, then answers",
  approval: { attended: true, sandbox: "unavailable" },
  phases: [
    {
      label: "the command asks, is allowed once, and runs without the sandbox",
      events: [
        ...opening(),
        stepStarted("a1"),
        called("a1", "call_1", "shell", plain("bun test")),
        approvalRequested("a1", "call_1", UNSANDBOXED),
        approvalAnswered("a1", "call_1", UNSANDBOXED, "once", 9),
        startedAs("a1", "call_1", "shell", ranUnder("auto", [], null)),
        settled("a1", "call_1", "success", "1 pass"),
        stepEnded("a1", "tool_calls"),
        ...answer("a2", "The test passes."),
      ],
      expect: { ui: [{ id: "u1" }, { id: "a1", calls: ["call_1 shell success"] }, { id: "a2" }], execution: null },
    },
  ],
}

export const approvalScenarios: readonly Scenario[] = [
  autoWithSandbox,
  networkEscalation,
  askMode,
  policyDenial,
  unattendedDeny,
  unattendedStop,
  rememberedApproval,
  questionInterrupted,
  questionCrashed,
  noSandbox,
]
