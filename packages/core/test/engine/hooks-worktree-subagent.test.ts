/**
 * The approvals of what a project's configuration file names (its hooks, its MCP servers, its language servers)
 * are the user's answer about the project, wherever a session of that project works.
 *
 * - A subagent the model gave a git worktree of its own (`worktree: true`) reads the worktree's copy of the
 *   project's file, and works outside the repository. The hook the user approved for the project runs for its
 *   calls too: the approval is looked up under the repository the worktree belongs to, so the call the hook
 *   refuses for the session is refused for the subagent as well. (docs/hooks.md: "In a subagent, before and
 *   after hooks run for its calls", "`y` allows it for this project for 30 days".)
 * - A session started in a subdirectory of the project reads the same file, found above it, and is under the
 *   same approvals: an approved hook is in force, an approved server starts, and an approval given there holds
 *   at the project's root.
 *
 * `projectApprovalHome` (engine/approval.ts) is the one key the three kinds of approval are kept under.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { ConfigFile } from "../../src/config/schema.ts"
import { projectApprovalHome } from "../../src/engine/approval.ts"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { Json } from "../../src/json.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { Harness, converse, removeHarnessDirectories } from "./harness.ts"
import { exited, scriptedRunner } from "../hooks/helpers.ts"
import { fixtureServer, waitFor } from "../mcp/helpers.ts"
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

test(
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

      // The subagent's call is refused too: it reads the worktree's copy of the file, and the approval is the project's.
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

test("a session started in a subdirectory of the project is under the project's approvals, and an approval given there holds at its root", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-hooks-subdirectory-")))
  made.push(root)
  const cwd = join(root, "repo")
  const sub = join(cwd, "packages", "app")
  mkdirSync(sub, { recursive: true })
  const project: ConfigFile = {
    verify: { mode: "off" },
    hooks: { beforeTool: [{ name: "repo-guard", tools: ["shell"], command: "guard" }] },
    mcp: { servers: { theirs: fixtureServer(["--only", "echo"]) } },
  }
  const scripted = scriptedRunner({ "repo-guard": exited(2, "Not in this repository.\n") })
  const h = new Harness({ cwd, config: project, userConfig: {}, hooks: { runner: scripted.runner }, mcp: { startWaitMs: 0, probeMs: 300, graceMs: 500 } })
  try {
    // The user approves the hook at the project's root, and the server in the subdirectory.
    const atRoot = h.create()
    expect(atRoot.approveHook(atRoot.hooks()!.awaiting[0]!.fingerprint)).toBe(true)
    expect(atRoot.mcp()!.awaiting.map((question) => question.name)).toEqual(["theirs"])
    const inside = h.engine.createSession({ cwd: sub, settings: { model: "gpt-test", reasoningEffort: "medium" } })
    expect(inside.hooks()!.awaiting).toEqual([])
    expect(inside.mcp()!.awaiting.map((question) => question.name)).toEqual(["theirs"])
    expect(inside.approveMcpServer("theirs")).toBe(true)
    await waitFor(() => inside.mcp()!.servers.some((server) => server.name === "theirs" && server.state === "ready"), 10_000, "the approved server to connect")

    // The hook is in force in the subdirectory: the call it guards is refused there.
    h.provider.enqueue([call("shell", { command: "ls" }), U], answer("Refused."))
    h.tools.on("shell", "a.txt")
    inside.send("List the files.")
    await inside.settled()
    expect(settledIn(h, inside.id).map((item) => [item.data.outcome, item.data.output])).toEqual([["error", 'This call was not run: the hook "repo-guard" refused it.\nNot in this repository.']])
    expect(h.tools.ran).toEqual([])
    await inside.close()

    // The server approved in the subdirectory needs no second answer at the root: the next session there has it.
    const again = h.engine.createSession({ cwd, settings: { model: "gpt-test", reasoningEffort: "medium" } })
    expect(again.mcp()!.awaiting).toEqual([])
    expect(again.hooks()!.awaiting).toEqual([])
    await again.close()
  } finally {
    await h.dispose()
  }
})

test("the approvals of a project are kept under its own directory; a worktree is taken back to the directory it stands for in its repository", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "review-approval-home-")))
  made.push(root)
  const repository = join(root, "repo")
  const worktree = join(root, "worktrees", "ses_1")
  for (const directory of [join(repository, "packages", "app"), join(worktree, "packages", "app")]) mkdirSync(directory, { recursive: true })
  symlinkSync(repository, join(root, "link"))
  const record = { path: worktree, repository }
  // No project file: the working directory itself, with links followed.
  expect(projectApprovalHome({ cwd: join(root, "link"), projectDir: null, worktree: null })).toBe(repository)
  // A subdirectory of the project: the project's directory, not the one the session works in.
  expect(projectApprovalHome({ cwd: join(repository, "packages", "app"), projectDir: repository, worktree: null })).toBe(repository)
  // A worktree: the repository, for its root and for a project file further down (a monorepo's package).
  expect(projectApprovalHome({ cwd: worktree, projectDir: worktree, worktree: record })).toBe(repository)
  expect(projectApprovalHome({ cwd: join(worktree, "packages", "app"), projectDir: join(worktree, "packages", "app"), worktree: record })).toBe(join(repository, "packages", "app"))
  // A project directory that is not in the worktree is left as it is.
  expect(projectApprovalHome({ cwd: worktree, projectDir: join(root, "elsewhere"), worktree: record })).toBe(join(root, "elsewhere"))
})
