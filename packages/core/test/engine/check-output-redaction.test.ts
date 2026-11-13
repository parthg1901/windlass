/**
 * The project's checks (the verification gate) keep their full output, and show their progress, redacted.
 *
 * Promise. docs/safety.md, "Secrets in tool output": "The same redaction covers what a running command shows while
 * it runs and the files that keep a long output in full (in the session's temp directory) ... Those files hold the
 * redacted output, not what the command printed byte for byte". The engine says of the gate's report (engine.ts,
 * the gate): "A check's output is tool output: what the model is shown of it is redacted like any other."
 *
 * How. A check runs through `verify/run.ts` `runCheck`, which calls the shell tool. The engine hands the runner
 * its redaction (`RunCheckOptions.redact` and `unfinishedSecret`), and `runCheck` passes both into the shell
 * tool's context, so the output is redacted as it arrives: the kept file `check-<name>-<sha>.log` (under the data
 * directory's `spill/checks/<session>`, or the session's temp directory when sandboxed, where the model's
 * sandboxed commands can read it) and every `checks.progress` event hold the placeholder, not the value. The
 * wake-up check runner (`wake/check.ts`) passes the same.
 *
 * What a fingerprint is of. The gate's result fingerprints (`verify/fingerprint.ts`) are of a check's definition
 * and the content of the changed files it depends on, never of its output: unchanged. The kept file is named by
 * the hash of the redacted output, and a wake-up check's `on_change` fingerprint is of the redacted output and
 * the exit code: output that differs only in a credential's value is the same output.
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
import { FakeWorkspace, ScriptedTools } from "./harness.ts"

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
const approval: ApprovalSetup = { sandbox, secrets: [VALUE], home: "/Users/user", user: { mode: "full" } }

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

test("a credential value a project's check prints is in neither its kept output file nor its progress", async () => {
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
    // The kept file holds the placeholder where the value was, and so does the progress line.
    for (const path of kept) expect(readFileSync(path, "utf8")).not.toContain(VALUE)
    expect(kept.map((path) => readFileSync(path, "utf8")).join("")).toContain("connecting with ")
    for (const text of progress) expect(text).not.toContain(VALUE)
  } finally {
    await engine.close()
    store.close()
  }
})
