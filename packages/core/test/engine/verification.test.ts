/**
 * The verification gate beyond what the scenarios spell out: which checks
 * apply, what counts as a change, the modes, when the configuration is read,
 * how the acknowledgement tool enters the frozen tool list, and what happens
 * when a check run goes wrong.
 */
import { afterAll, describe, expect, test } from "bun:test"
import type { ConfigFile } from "../../src/config/schema.ts"
import { resolveConfig } from "../../src/config/schema.ts"
import type { EngineEvent } from "../../src/engine/channel.ts"
import type { StoredEvent, VerificationOutcome } from "../../src/event/durable.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { FakeWorkspace, Harness, removeHarnessDirectories, untilAbort } from "./harness.ts"

afterAll(removeHarnessDirectories)

const CHECKS: ConfigFile = { checks: [{ name: "test", command: "bun test" }] }
const types = (h: Harness): string[] => h.log().map((item) => item.type)
const call = (name: string, input: Json, callId = "call_1") => [script.toolCall(callId, name, input)]
const write = (path: string, content: string) => call("write", { path, content })
const say = (value: string) => [script.text(value)]
/** The gate outcome of each execution that ended as done, in order. */
const outcomes = (h: Harness): VerificationOutcome[] => h.log().flatMap((item) => (item.type === "execution.succeeded" ? [item.data.verification] : []))
const reports = (h: Harness) => h.log().filter((item): item is StoredEvent<"synthetic.appended"> => item.type === "synthetic.appended" && item.data.origin === "check_report")

interface Options {
  readonly config?: ConfigFile
  readonly files?: Record<string, string>
  readonly snapshots?: boolean
  readonly limits?: ConstructorParameters<typeof Harness>[0] extends infer O ? (O extends { limits?: infer L } ? L : never) : never
}

async function withProject(run: (h: Harness) => Promise<void>, options: Options = {}) {
  const h = new Harness({
    ...(options.config === undefined ? { config: CHECKS } : { config: options.config }),
    ...(options.snapshots === false ? {} : { workspace: new FakeWorkspace(options.files ?? { "a.ts": "1\n", "README.md": "hi\n" }) }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  // The scripted write tool changes the workspace, like the real one.
  const writes = (input: Record<string, unknown>) => {
    h.workspace?.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  }
  h.tools.on("write", ...Array.from({ length: 8 }, () => writes))
  try {
    await run(h)
    h.verify()
  } finally {
    await h.dispose()
  }
}

describe("which checks run", () => {
  test("a turn that changed no file runs no check and ends as not needed", () =>
    withProject(async (h) => {
      h.provider.enqueue(call("read", { path: "a.ts" }), say("It is 1."))
      h.tools.on("read", "1")
      h.create().send("What is in a.ts?")
      await h.settled()
      expect(h.checks.ran).toEqual([])
      expect(outcomes(h)).toEqual([{ status: "not_needed" }])
      // A step of reads takes no snapshot of its own: the one before the prompt and the one at the gate are the same state.
      expect(h.log().flatMap((item) => (item.type === "snapshot.taken" ? [item.data.point] : []))).toEqual(["delivery", "checks_start"])
    }))

  test("a check with `when` runs only when a changed file matches it, and what it did not cover is not checked later either", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("README.md", "hello\n"), say("Updated the readme."), write("a.ts", "2\n"), say("Changed a."))
        h.checks.on("test", "passed")
        h.create().send("Update the readme.")
        await h.settled()
        expect(h.checks.ran).toEqual([])
        expect(outcomes(h)).toEqual([{ status: "not_needed" }])

        h.session.send("Now change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        // The evidence lists what changed since the last time nothing was left to check: only a.ts.
        expect(outcomes(h)[1]).toMatchObject({ status: "passed", evidence: { run: 1, changedFiles: ["a.ts"], checks: [{ name: "test", status: "passed", files: ["a.ts"] }] } })
      },
      { config: { checks: [{ name: "test", command: "bun test", when: ["**/*.ts"] }] } },
    ))

  test("after a pass, a turn that changes nothing is not checked again", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("Nothing to do."))
      h.checks.on("test", "passed")
      h.create().send("Change a.ts.")
      await h.settled()
      h.session.send("Anything else?")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      expect(outcomes(h).map((outcome) => outcome.status)).toEqual(["passed", "not_needed"])
    }))

  test("changes left unresolved are not checked by a turn that changes nothing, and are checked with the next turn that changes a file", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("Still done."), say("They fail because of a.ts."), write("README.md", "hello\n"), say("Updated the readme."), say("Still failing."))
        h.checks.on("test", "failed", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "max_rounds", failing: ["test"] }])
        const verified = h.session.projection().session.verification.verified

        // A question: nothing of this turn's to verify. What the turn before left failing is still unverified, and the ending says so.
        h.session.send("Why do they fail?")
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        expect(outcomes(h)[1]).toEqual({ status: "not_needed", unverified: true })
        expect(h.session.projection().session.verification.verified).toEqual(verified)

        // The next turn changes another file: the checks are selected from everything unverified, a.ts included.
        h.session.send("Update the readme.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test", "test"])
        expect(outcomes(h)[2]).toMatchObject({ status: "unresolved", reason: "max_rounds", evidence: { changedFiles: ["README.md", "a.ts"] } })
      },
      { config: { ...CHECKS, verify: { maxRounds: 1 } } },
    ))

  test("a model that says done again without changing anything is shown the same report, and the checks are not run twice", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("It is done, really."), say("I insist."))
        h.checks.on("test", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        expect(reports(h)).toHaveLength(2)
        expect(reports(h)[1]!.data.content).toEqual(reports(h)[0]!.data.content)
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "max_rounds", evidence: { run: 1 } }])
        // Every request extended the one before it: a report is an appended message.
        expect(h.provider.prefixBreaks()).toEqual([])
      },
      { config: { ...CHECKS, verify: { maxRounds: 2 } } },
    ))

  test("files a check itself writes do not count as a change by the model", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("Still done."))
        h.checks.on("test", () => {
          h.workspace!.files.set("coverage.txt", `run ${h.checks.ran.length}\n`)
          return "failed"
        })
        h.create().send("Change a.ts.")
        await h.settled()
        // One run: the snapshot taken right after it already holds what the check wrote.
        expect(h.checks.ran).toEqual(["test"])
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "max_rounds" }])
      },
      { config: { ...CHECKS, verify: { maxRounds: 1 } } },
    ))

  test("without snapshots every check runs after a call that can change files, and none after a turn of reads", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(call("read", { path: "a.ts" }), say("It is 1."), write("a.ts", "2\n"), say("Changed."))
        h.tools.on("read", "1")
        h.checks.on("test", "passed")
        h.create().send("What is in a.ts?")
        await h.settled()
        expect(h.checks.ran).toEqual([])
        h.session.send("Change it.")
        await h.settled()
        expect(h.checks.ran).toEqual(["test"])
        expect(outcomes(h)).toMatchObject([{ status: "not_needed" }, { status: "passed", evidence: { changedFiles: [] } }])
        expect(types(h)).not.toContain("snapshot.taken")
      },
      { snapshots: false, config: { checks: [{ name: "test", command: "bun test", when: ["never-matches"] }] } },
    ))
})

describe("modes and configuration", () => {
  test("in report mode a failure is recorded and told to the model, which is not sent back", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("I see the failure."))
        h.checks.on("test", "failed", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(types(h).slice(-3)).toEqual(["checks.finished", "synthetic.appended", "execution.succeeded"])
        expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "report_mode", failing: ["test"], acknowledgement: null }])
        expect(h.provider.calls).toHaveLength(2)
        // Whoever continues sees the report: it is the last thing in the next turn's history before the new prompt.
        h.session.send("What happened?")
        await h.settled()
        const input = JSON.stringify(h.provider.requests[2]!.input)
        expect(input).toContain("Checks run by the harness after your changes: 1 failed.")
        expect(h.provider.prefixBreaks()).toEqual([])
      },
      { config: { ...CHECKS, verify: { mode: "report" } } },
    ))

  test("with verification off nothing runs and the tool list has no acknowledgement tool", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
        h.create().send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)).toEqual([{ status: "not_configured" }])
        expect(h.provider.requests[0]!.tools.map((tool) => tool.name)).toEqual(["history_read", "history_search", "read", "shell", "write"])
      },
      { config: { ...CHECKS, verify: { mode: "off" } } },
    ))

  test("the acknowledgement tool is in the list whenever verification is not off at the baseline, checks or not, and stays whatever the configuration becomes", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(say("Hello."), write("a.ts", "2\n"), say("Done."), say("Bye."))
        h.checks.on("test", "passed")
        h.create().send("Hi.")
        await h.settled()
        const tools = h.provider.requests[0]!.tools.map((tool) => tool.name)
        expect(tools).toEqual(["history_read", "history_search", "read", "report_check_failure", "shell", "write"])
        expect(outcomes(h)).toEqual([{ status: "not_configured" }])

        // Checks are added while the session is idle: they apply from the next turn, and the tool list is the same bytes.
        h.config = resolveConfig(CHECKS)
        h.session.send("Change a.ts.")
        await h.settled()
        expect(outcomes(h)[1]).toMatchObject({ status: "passed" })

        // Verification is switched off: nothing runs any more, and the frozen list still has the tool.
        h.config = resolveConfig({ ...CHECKS, verify: { mode: "off" } })
        h.session.send("One more.")
        await h.settled()
        expect(outcomes(h)[2]).toEqual({ status: "not_configured" })
        expect(h.provider.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(tools)
        expect(h.provider.prefixBreaks()).toEqual([])
      },
      { config: {} },
    ))

  test("a configuration change in the middle of a turn takes effect at the next one", () =>
    withProject(async (h) => {
      h.provider.enqueue(
        () => {
          // The file changes on disk while the first turn is running.
          h.config = resolveConfig({ checks: [{ name: "lint", command: "bun lint" }] })
          return write("a.ts", "2\n")
        },
        say("Done."),
        write("a.ts", "3\n"),
        say("Done again."),
      )
      h.checks.on("test", "passed").on("lint", "passed")
      h.create().send("Change a.ts.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test"])
      h.session.send("Again.")
      await h.settled()
      expect(h.checks.ran).toEqual(["test", "lint"])
    }))

  test("an acknowledgement that does not name every failing check does not end the turn", () =>
    withProject(
      async (h) => {
        h.provider.enqueue(
          write("a.ts", "2\n"),
          say("Done."),
          call("report_check_failure", { checks: ["lint"], reason: "The linter is broken." }),
          say("I reported it."),
          call("report_check_failure", { checks: ["lint", "test"], reason: "Both are broken." }),
          say("Reported both."),
        )
        h.checks.on("test", "failed").on("lint", "failed")
        h.create().send("Change a.ts.")
        await h.settled()
        expect(reports(h)).toHaveLength(2)
        expect(outcomes(h)).toMatchObject([
          { status: "unresolved", reason: "acknowledged", failing: ["test", "lint"], acknowledgement: { checks: ["lint", "test"], reason: "Both are broken." } },
        ])
      },
      { config: { checks: [{ name: "test", command: "bun test" }, { name: "lint", command: "bun lint" }] } },
    ))
})

describe("a configuration that cannot be loaded", () => {
  test("fails the execution before anything is sent and leaves the prompt waiting", async () => {
    const h = new Harness({ config: CHECKS })
    try {
      // What `loadConfig` does with an invalid file.
      Object.defineProperty(h, "config", {
        get: () => {
          throw new Error('/repo/.windlass/config.json: verify: unknown key "mod" (did you mean "mode"?)')
        },
      })
      h.provider.enqueue(say("Never sent."))
      h.create().send("Go.")
      await h.settled()
      expect(types(h)).toEqual(["session.created", "inbox.enqueued", "execution.started", "execution.failed"])
      expect(h.log().at(-1)).toMatchObject({ data: { message: expect.stringContaining('unknown key "mod"') } })
      expect(h.provider.calls).toHaveLength(0)
      expect(h.session.projection().inbox).toHaveLength(1)
    } finally {
      await h.dispose()
    }
  })
})

describe("a run of checks that does not go to plan", () => {
  test("input that arrives while the checks run is delivered after them, and the turn is checked again at its end", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), say("Sure."))
      h.checks.on(
        "test",
        () => {
          h.session.send("One more thing.")
          return "failed"
        },
        "passed",
      )
      h.create().send("Change a.ts.")
      await h.settled()
      const log = types(h)
      // The first run and its report are on record; the steer is delivered next to the report.
      expect(log.slice(log.indexOf("checks.finished"), log.indexOf("checks.finished") + 4)).toEqual(["checks.finished", "synthetic.appended", "snapshot.taken", "inbox.delivered"])
      expect(h.checks.ran).toEqual(["test", "test"])
      expect(outcomes(h)).toMatchObject([{ status: "passed", evidence: { run: 1 } }])
    }))

  test("a check runner that throws fails the execution and closes the run, and the session stays usable", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("a.ts", "3\n"), say("Again."))
      h.checks.on(
        "test",
        () => {
          throw new Error("the runner broke")
        },
        "passed",
      )
      h.create().send("Change a.ts.")
      await h.settled()
      expect(types(h).slice(-2)).toEqual(["checks.failed", "execution.failed"])
      expect(h.log().at(-2)).toMatchObject({ data: { run: 1, error: { kind: "internal", message: "the runner broke" } } })
      expect(h.diagnostics.map((item) => item.kind)).toEqual(["internal_error"])
      h.session.send("Try again.")
      await h.settled()
      expect(outcomes(h)).toMatchObject([{ status: "passed" }])
    }))

  test("a check that kills the process every time stops at the resume cap instead of running for ever", async () => {
    const h = new Harness({ config: CHECKS, workspace: new FakeWorkspace({ "a.ts": "1\n" }), limits: { crashResumeCap: 2 } })
    try {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
      h.tools.on("write", (input) => {
        h.workspace!.files.set(String(input.path), String(input.content))
        return "Wrote a.ts"
      })
      h.dieAt("checks.started")
      h.create().send("Change a.ts.")
      await h.settled()
      for (let crash = 0; crash < 2; crash += 1) {
        h.boot()
        h.dieAt("checks.started")
        h.open()
        await h.settled()
      }
      h.restart()
      await h.settled()
      expect(types(h).slice(-2)).toEqual(["checks.failed", "execution.failed"])
      expect(types(h).filter((type) => type === "checks.started")).toHaveLength(3)
      expect(h.log().at(-1)).toMatchObject({ data: { message: "Gave up after the harness restarted 2 times during this turn." } })
      h.verify()
    } finally {
      await h.dispose()
    }
  })

  test("a shutdown while the checks run suspends the execution, and the next start runs them again", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
      h.checks.on("test", async (_check, options) => {
        await untilAbort(options.signal)
        return "interrupted" as const
      })
      h.create().send("Change a.ts.")
      await h.seen((item) => item.type === "checks.started")
      await h.engine.close()
      h.kill()
      expect(types(h.restartForLog()).slice(-3)).toEqual(["execution.interrupt_requested", "checks.failed", "execution.interrupted"])
      h.checks.on("test", "passed")
      h.open()
      await h.settled()
      expect(outcomes(h)).toMatchObject([{ status: "passed" }])
      expect(h.provider.calls).toHaveLength(2)
    }))

  test("progress of a running check is streamed, and the files the execution changed are announced before it ends", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."))
      h.checks.on("test", (check, options) => {
        options.progress?.(check.name, "3 pass")
        return "passed"
      })
      h.create().send("Change a.ts.")
      await h.settled()
      const seen = h.seenEvents.filter((item: EngineEvent) => item.type === "checks.progress" || item.type === "workspace.changes")
      expect(seen).toMatchObject([
        { type: "checks.progress", run: 1, check: "test", text: "3 pass" },
        { type: "workspace.changes", files: ["a.ts"] },
      ])
    }))

  test("the changed files are announced once, when the execution ends, not with every round of checks", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), write("README.md", "better\n"), say("Done now."))
      h.checks.on("test", "failed", "passed")
      h.create().send("Change a.ts.")
      await h.settled()
      const announced = h.seenEvents.filter((item: EngineEvent) => item.type === "workspace.changes")
      expect(announced).toMatchObject([{ files: ["README.md", "a.ts"] }])
      // It is the last thing before the events that end the execution.
      const order = h.seenEvents.map((item) => item.type)
      expect(order.slice(order.lastIndexOf("workspace.changes"))).toEqual(["workspace.changes", "checks.finished", "execution.succeeded"])
    }))

  test("a model that names the check the way the report shows it has acknowledged it", () =>
    withProject(async (h) => {
      h.provider.enqueue(write("a.ts", "2\n"), say("Done."), call("report_check_failure", { checks: ["test (bun test)"], reason: "The fixture is not mine to change." }), say("Reported."))
      h.checks.on("test", "failed")
      h.create().send("Change a.ts.")
      await h.settled()
      expect(outcomes(h)).toMatchObject([{ status: "unresolved", reason: "acknowledged", failing: ["test"], acknowledgement: { checks: ["test (bun test)"] } }])
    }))
})
