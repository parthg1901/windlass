/**
 * The project's checks (the verification gate) keep their full output, and show their progress, unredacted.
 *
 * Promise. docs/safety.md, "Secrets in tool output": "The same redaction covers what a running command shows while
 * it runs and the files that keep a long output in full (in the session's temp directory) ... Those files hold the
 * redacted output, not what the command printed byte for byte". The engine says of the gate's report (engine.ts,
 * the gate): "A check's output is tool output: what the model is shown of it is redacted like any other."
 *
 * What happens. The report the model is shown is redacted after it is rendered, but the check itself runs through
 * `verify/run.ts` `runCheck`, which calls the shell tool with a context that has no `redact` and no
 * `unfinishedSecret`. So `createOutputBuffer` (tools/shell.ts) gets no `redactingStream`: the kept file
 * `check-<name>-<sha>.log` (under the data directory's `spill/checks/<session>`, or the session's temp directory when
 * sandboxed, where the model's sandboxed commands can read it) holds the credential value as printed, and every
 * `checks.progress` event a client shows carries it too.
 *
 * Code path. packages/core/src/verify/run.ts `runCheck` (the `tool.execute(..., { sessionId, messageId, callId,
 * cwd, signal, progress, putBlob })` context: no `redact`); `RunCheckOptions` has no way to pass one;
 * packages/core/src/engine/engine.ts, the gate's `this.core.runChecks(checks, { cwd, spillDir, signal, sandbox,
 * progress })` (about line 4728).
 *
 * Smallest fix. Add `redact` and `unfinishedSecret` to `RunCheckOptions` and pass them into the shell tool's context
 * in `runCheck`; have the engine pass `redactor(approvals.secrets)` as it does for tool calls. The wake-up check
 * runner (`wake/check.ts`) goes through `runCheck` too and would get the same.
 *
 * What else the fix affects. The output's fingerprint (`fingerprints` of the gate's evidence, and a wake-up check's
 * `on_change` fingerprint) would be computed over redacted text: a check whose only change is a credential value
 * would no longer count as changed. The gate's `renderReport` input becomes already redacted, which the later
 * `redact` leaves as it is (it is idempotent).
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../../src/config/schema.ts"
import type { ApprovalSetup } from "../../src/engine/approval.ts"
import { createEngine } from "../../src/engine/engine.ts"
import type { ExecutionId, MessageId, RequestId, SessionId } from "../../src/id.ts"
import { dateSource } from "../../src/instructions/source.ts"
import type { Json } from "../../src/json.ts"
import type { CommandSandbox } from "../../src/sandbox/command.ts"
import { openSqliteStore } from "../../src/store/sqlite.ts"
import { FakeProvider, script } from "../../src/testing/fake-provider.ts"
import { measured } from "../scenarios/script.ts"
import { FakeWorkspace, ScriptedTools } from "../engine/harness.ts"

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

const VALUE = "EXAMPLE_VALUE_123456789"
const U = script.usage(measured(1000))
const sandbox: CommandSandbox = {
  state: { available: true },
  temp: (sessionId) => ({ dir: `/sandbox-tmp/${sessionId}`, alias: "/tmp" }),
  plan: () => {
    throw new Error("in full mode the checks are not sandboxed")
  },
  policy: () => {
    throw new Error("in full mode the checks are not sandboxed")
  },
}
// `full`: the project's checks run unsandboxed, so the real check runner runs a harmless `cat` here.
const approval: ApprovalSetup = { sandbox, secrets: [VALUE], home: "/home/user", user: { mode: "full" } }

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

test.failing("a credential value a project's check prints is in neither its kept output file nor its progress", async () => {
  const directory = mkdtempSync(join(tmpdir(), "review-checks-"))
  directories.push(directory)
  const project = mkdtempSync(join(tmpdir(), "review-project-"))
  directories.push(project)
  const store = openSqliteStore({ path: join(directory, "store.db"), now: Date.now })
  const provider = new FakeProvider()
  const tools = new ScriptedTools()
  const workspace = new FakeWorkspace({ "a.ts": "1\n" })
  tools.on("write", (input) => {
    workspace.files.set(String(input.path), String(input.content))
    return `Wrote ${String(input.path)}`
  })
  const counters = { session: 0, message: 0, execution: 0, request: 0, spawn: 0 }
  // The value is in a file the check prints, not in the command, which is stored as configured.
  writeFileSync(join(project, "connection.txt"), `connecting with ${VALUE}\n`)
  const file = { checks: [{ name: "connect", command: "cat connection.txt" }] }
  const loaded = () => ({ config: resolveConfig(file), projectDir: project, files: { user: null, project: file as never }, approval: { user: null, project: null } })
  const engine = createEngine({
    store,
    provider,
    tools: tools.list(),
    dataDir: directory,
    workDir: join(directory, "work"),
    random: () => 0,
    limits: { modelCallTimeoutMs: 0, compactionCallTimeoutMs: 0 },
    snapshots: workspace.open,
    approval,
    loadConfig: async () => loaded(),
    loadConfigSync: () => loaded(),
    prompt: "You are a coding agent.",
    discover: () => [dateSource(2026, 11, 12)],
    ids: {
      session: () => `ses_${++counters.session}` as SessionId,
      message: () => `msg_${++counters.message}` as MessageId,
      execution: () => `exe_${++counters.execution}` as ExecutionId,
      request: () => `req_${++counters.request}` as RequestId,
      spawn: () => `bg_${++counters.spawn}`,
    },
    log: () => {},
    strict: true,
  })
  try {
    provider.enqueue([script.toolCall("call_1", "write", { path: "a.ts", content: "2\n" } as Json), U], [script.text("Changed a."), U])
    const session = engine.createSession({ cwd: project, settings: { model: "gpt-test", reasoningEffort: "medium" } })
    const progress: string[] = []
    session.subscribe((item) => {
      if (item.type === "checks.progress") progress.push((item as { text: string }).text)
    })
    session.send("Change a.ts.")
    await session.settled()
    const log = store.readEvents(session.id)
    // The check did run, and passed.
    expect(log.some((item) => item.type === "checks.finished")).toBe(true)
    // What is stored is redacted.
    expect(JSON.stringify(log)).not.toContain(VALUE)

    const kept = filesUnder(directory).filter((path) => /check-connect-[0-9a-f]+\.log$/.test(path))
    expect(kept.length).toBeGreaterThan(0)
    // Today the kept file reads "connecting with EXAMPLE_VALUE_123456789\n", and so does the progress line.
    for (const path of kept) expect(readFileSync(path, "utf8")).not.toContain(VALUE)
    for (const text of progress) expect(text).not.toContain(VALUE)
  } finally {
    await engine.close()
    store.close()
  }
})
