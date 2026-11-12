/**
 * Review finding: a project's before hook the user approved does not run for a subagent that works in a git
 * worktree, so the call it exists to refuse goes through.
 *
 * What is promised.
 * - docs/hooks.md, "Where hooks run": "In a subagent, before and after hooks run for its calls; stop hooks run
 *   only for the turn of the session you talk to."
 * - docs/hooks.md, "Approving, listing and seeing hooks": "`y` allows it for this project for 30 days".
 *
 * What happens. The model passes `worktree: true` on a `subagent` call (its own choice; the tool's description
 * offers it). The child's working directory is then the worktree, outside the repository. The child reads the
 * project's configuration from the worktree's copy of the file, so it has the same hook with the same
 * fingerprint, but it looks the approval up under its own working directory. Approvals are kept per workspace
 * path, the worktree's path has none, and the hook is planned as `skip` ("not approved"): the child's call runs
 * as if the hook did not exist, while the very same call made by the parent is refused. The notice the user gets
 * says the hook "runs only after you approve it", which they did.
 *
 * Code path. `LiveSession.readHooks` and `approveHook` (packages/core/src/engine/engine.ts) both key the
 * approvals by `realWorkspace(this.projection().session.cwd)`; `subagent` in the same file gives a worktree
 * child `cwd = made.cwd`; `planHookRun` (packages/core/src/hooks/trust.ts) then returns `skip`.
 *
 * Smallest fix. In `readHooks` (and `approveHook`), look the approvals up under the workspace the approval
 * belongs to: for a session whose lineage is a spawn with a worktree, `lineage.worktree.repository` (the
 * parent's workspace) instead of the child's own `cwd`.
 *
 * What that fix could affect. The same key is used for a project's MCP servers and language servers and for
 * remembered tool approvals; those fail closed today in a worktree child (not started, asked again), so changing
 * only the hooks' lookup leaves them as they are. A session started in a subdirectory of a repository has the
 * same mismatch (the project's file is found above it, the approval is kept under the subdirectory), but there
 * the user is asked again; a fix that keys by the project's directory would cover both and would change where
 * existing approvals are found.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, converse, removeHarnessDirectories } from "../engine/harness.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { measured } from "../scenarios/script.ts"

const made: string[] = []
afterAll(() => {
  removeHarnessDirectories()
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const U = script.usage(measured(1000))
const call = (name: string, input: Json, callId = "call_1") => script.toolCall(callId, name, input)
const answer = (text: string) => [script.text(text), U]
const settledIn = (h: Harness, id: SessionId) => h.store.readEvents(id).filter((item): item is StoredEvent<"tool.settled"> => item.type === "tool.settled")

test.failing(
  "a project's hook the user approved should also refuse the call of a subagent that works in a worktree",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "review-hooks-worktree-")))
    made.push(root)
    const cwd = join(root, "repo")
    const project: ConfigFile = { verify: { mode: "off" }, hooks: { beforeTool: [{ name: "repo-guard", tools: ["shell"], command: "guard" }] } }
    // The project's file is part of the repository, so the worktree has it too (the real loader finds it there).
    mkdirSync(join(cwd, `.${brand.directory}`), { recursive: true })
    writeFileSync(join(cwd, `.${brand.directory}`, "config.json"), JSON.stringify(project))
    writeFileSync(join(cwd, "a.txt"), "a\n")
    const git = Bun.spawnSync(["sh", "-c", "git init -q -b main && git add -A && git -c user.name=review -c user.email=review@localhost commit -q -m first"], {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    })
    expect(git.exitCode).toBe(0)

    const scripted = scriptedRunner({ "repo-guard": exited(2, "Not in this repository.\n") })
    const h = new Harness({ cwd, config: project, hooks: { runner: scripted.runner }, spawn: { worktreeDir: join(root, "worktrees") } })
    try {
      converse(h.provider, {
        // The same command twice: once by a subagent in a worktree, once by the session itself.
        "Delegate": [[call("subagent", { task: "Run it", worktree: true }), U], [call("shell", { command: "ls" }), U], answer("Done.")],
        "Run it": [[call("shell", { command: "ls" }), U], answer("Ran.")],
      })
      h.tools.on("shell", "a.txt", "a.txt")
      h.create()
      // The user approves the project's hook, as the question at the session's opening lets them.
      expect(h.session.approveHook(h.session.hooks()!.awaiting[0]!.fingerprint)).toBe(true)
      h.session.send("Delegate.")
      await h.settled()

      // The session's own call is refused by the hook: the approval is in force.
      const own = settledIn(h, h.session.id).find((item) => item.data.output.includes("repo-guard"))
      expect(own?.data).toMatchObject({ outcome: "error", output: 'This call was not run: the hook "repo-guard" refused it.\nNot in this repository.' })

      // The subagent's call must be refused too. Today the hook is skipped there and the command runs.
      const child = h.session.projection().session.spawned!.children[0]!
      expect(h.store.getProjection(child)!.session.cwd.startsWith(join(root, "worktrees"))).toBe(true)
      expect(settledIn(h, child).map((item) => [item.data.outcome, item.data.output])).toEqual([["error", 'This call was not run: the hook "repo-guard" refused it.\nNot in this repository.']])
      expect(h.tools.ran).toEqual([])
    } finally {
      await h.dispose()
    }
  },
  60_000,
)
