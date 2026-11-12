/**
 * Hooks on real commands: for each point, what the model would see. A user's configuration blocks `git push`,
 * trims trailing spaces after an edit and refuses to end the turn while SCRATCH.md exists; a project's
 * configuration has a hook the user has not approved (it is not run), then approves it, then edits it (it needs
 * approval again). The last part shows the stop bound and a hook that hangs.
 *
 *   bun scripts/hooks-demo.ts
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../packages/core/src/brand.ts"
import { type Hook, HOOK_ENV_PREFIX, createHookRunner, parseHooksSection, pendingHookApprovals, resolveHooksConfig, runAfterHooks, runBeforeHooks, runStopHooks } from "../packages/core/src/hooks/index.ts"
import type { HookPointContext, HookRecord } from "../packages/core/src/hooks/points.ts"
import { createCommandSandbox } from "../packages/core/src/sandbox/command.ts"
import { detectSandbox } from "../packages/core/src/sandbox/detect.ts"

const base = realpathSync(mkdtempSync(join(tmpdir(), `${brand.binary}-hooks-demo-`)))
const cwd = join(base, "repo")
const P = HOOK_ENV_PREFIX
await Bun.write(join(cwd, "a.ts"), "export const a = 1   \n")

const user = parseHooksSection(
  {
    beforeTool: [{ name: "no-push", tools: ["shell"], command: `case "$${P}COMMAND" in *"git push"*) echo "Pushing is not allowed here; commit locally and tell the user."; exit 2;; esac` }],
    afterTool: [{ name: "trim", tools: ["edit", "write"], paths: ["**/*.ts"], command: `printf '%s\\n' "$${P}PATHS" | while read -r f; do sed -i 's/[ ]*$//' "$f"; done; echo "Trimmed trailing spaces in $${P}PATHS."; exit 2` }],
    stop: [{ name: "no-scratch", command: "if [ -e SCRATCH.md ]; then echo 'Delete SCRATCH.md before you finish.'; exit 2; fi" }],
    maxStopRounds: 2,
  },
  "~/.config/<dir>/config.json",
  "user",
)
const projectSection = (command: string) => parseHooksSection({ beforeTool: [{ name: "repo-guard", tools: ["write"], command }] }, ".<dir>/config.json", "project")

const sandboxAvailable = detectSandbox().available
const runner = createHookRunner({ spillDir: join(base, "spill"), ...(sandboxAvailable ? { sandbox: createCommandSandbox({ tempBase: join(base, "sandbox") }) } : {}) })
const approved = new Set<string>()
const context = (): HookPointContext => ({
  runner,
  trust: { mode: "auto", tainted: false, sandboxAvailable, isApproved: (hook: Hook) => approved.has(hook.fingerprint) },
  cwd,
  sessionId: "ses_demo",
  signal: new AbortController().signal,
  untrustedRepository: false,
})

const rule = (title: string) => console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(Math.max(0, 70 - title.length))}`)
const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n")
const records = (list: readonly HookRecord[]) => {
  for (const record of list)
    console.log(
      `  record: ${record.origin} hook "${record.name}" ${record.run.kind === "ran" ? (record.run.sandbox === null ? "ran unsandboxed" : "ran in the sandbox") : record.run.kind === "skipped" ? `skipped (${record.run.reason})` : "could not run"}, answer ${record.answer}${record.failure === null ? "" : ` (${record.failure}: ${record.detail})`}`,
    )
}

console.log(`Sandbox on this machine: ${sandboxAvailable ? "yes, hooks run in it" : "no: the user's hooks run unsandboxed, the project's cannot run"}`)

rule("before: the model asks for `git push origin main`")
let config = resolveHooksConfig(user, projectSection("true"))
const push = await runBeforeHooks(context(), config.beforeTool, { tool: "shell", callId: "call_1", arguments: { command: "git push origin main" }, paths: null })
console.log(push.decision.kind === "refuse" ? `The call is settled without running. The model sees its result:\n${indent(push.decision.output)}` : `decision: ${push.decision.kind}`)
records(push.records)

rule("before: `git status` (no objection; approval decides as usual)")
const status = await runBeforeHooks(context(), config.beforeTool, { tool: "shell", callId: "call_2", arguments: { command: "git status" }, paths: null })
console.log(`decision: ${status.decision.kind}`)
records(status.records)

rule("after: an edit of a.ts")
const edited = { status: "success" as const, output: "Edited a.ts (1 change).", truncation: null, attachments: [], display: null }
const after = await runAfterHooks(context(), config.afterTool, { tool: "edit", callId: "call_3", arguments: { path: "a.ts", old_string: "1", new_string: "1" }, paths: ["a.ts"] }, edited)
console.log(`The model sees the tool's result with the note after it, capped and stored with it:\n${indent(after.result.output)}`)
console.log(`a.ts is now ${JSON.stringify(await Bun.file(join(cwd, "a.ts")).text())}`)
records(after.records)

rule("stop: the model says it is done while SCRATCH.md exists")
writeFileSync(join(cwd, "SCRATCH.md"), "notes")
const turn = { maxRounds: config.maxStopRounds, lastText: "All done." }
for (let roundsSent = 0; ; roundsSent += 1) {
  const stop = await runStopHooks(context(), config.stop, { ...turn, roundsSent })
  if (stop.decision.kind === "continue") console.log(`Sent back. The model is given this message:\n${indent(stop.decision.message)}`)
  else if (stop.decision.kind === "end_unsatisfied") console.log(`The bound is reached; the turn ends. The user is told:\n${indent(stop.decision.notice)}`)
  else console.log(`The turn ends (${stop.decision.kind}).`)
  if (stop.decision.kind !== "continue") break
}
rmSync(join(cwd, "SCRATCH.md"))
const clean = await runStopHooks(context(), config.stop, { ...turn, roundsSent: 0 })
console.log(`After SCRATCH.md is deleted: ${clean.decision.kind}`)

rule("a project's hook: unapproved, approved, edited")
const write = { tool: "write", callId: "call_4", arguments: { path: "b.ts", content: "x" }, paths: ["b.ts"] }
const pending = pendingHookApprovals(config, (hook) => approved.has(hook.fingerprint))
console.log(`Needs the user's approval (the question, word for word):\n${indent(pending[0]!.question)}`)
records((await runBeforeHooks(context(), config.beforeTool, write)).records)
approved.add(pending[0]!.fingerprint)
console.log("The user approves it.")
records((await runBeforeHooks(context(), config.beforeTool, write)).records)
config = resolveHooksConfig(user, projectSection("true # now with an edit"))
console.log("The repository edits the hook:")
records((await runBeforeHooks(context(), config.beforeTool, write)).records)
console.log(`Needs approval again: ${pendingHookApprovals(config, (hook) => approved.has(hook.fingerprint)).map((request) => request.hook.name).join(", ")}`)

rule("a before hook that hangs (timeout 1 s): the call is refused, fail closed")
const slow = resolveHooksConfig(parseHooksSection({ beforeTool: [{ name: "slow", command: "sleep 30", timeoutSeconds: 1 }] }, "user.json", "user"), undefined)
const hung = await runBeforeHooks(context(), slow.beforeTool, { tool: "read", callId: "call_5", arguments: { path: "a.ts" }, paths: ["a.ts"] })
if (hung.decision.kind === "refuse") console.log(`The model sees:\n${indent(hung.decision.output)}`)
records(hung.records)

rmSync(base, { recursive: true, force: true })
