/**
 * Subagents and background commands with the real tools: a real shell
 * command in the background (a real process group, its log file, its exit
 * waking the session, a stop that kills it), and subagents in real git
 * worktrees whose work is merged back or reported as a conflict, with the
 * user's repository otherwise untouched.
 */
import { afterAll, afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { StoredEvent } from "../../src/event/durable.ts"
import type { SessionId } from "../../src/id.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import { type ScriptedResponse, script } from "../../src/testing/fake-provider.ts"
import { SETTINGS, call, closeHarnesses, place, removePlaces, say, start, until } from "./assembly-helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(closeHarnesses)
afterAll(removePlaces)

const of = <T extends StoredEvent["type"]>(events: readonly StoredEvent[], type: T) => events.filter((item) => item.type === type) as unknown as StoredEvent<T>[]
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sh = (cwd: string, command: string) => {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (done.exitCode !== 0) throw new Error(`${command}: ${done.stderr.toString()}`)
  return done.stdout.toString()
}

describe("a real background command", () => {
  test("runs beside the session's steps, writes its log, and its exit wakes the idle session with its output", async () => {
    const { data, workspace } = place("wl-bg-")
    const directory = workspace("w")
    const { harness, provider } = start(data, [[call("shell", { command: "sleep 0.4; echo tests passed; exit 3", background: true })], [call("read", { path: "notes.md" })], say("Reading while it runs."), say("It exited with 3.")])
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Run the slow thing in the background.")
    await session.settled()
    // The turn ended while the command still ran.
    expect(session.projection().session.spawned?.running).toHaveLength(1)
    const started = of(session.readEvents(), "spawn.started")[0]!
    const logPath = started.data.work.kind === "command" ? started.data.work.logPath! : ""
    await until(() => session.projection().session.spawned?.running.length === 0)
    await until(() => !session.working && session.readEvents().at(-1)?.type === "execution.succeeded")
    const log = session.readEvents()
    expect(of(log, "spawn.ended")[0]!.data).toMatchObject({ outcome: "completed", exitCode: 3 })
    expect(readFileSync(logPath, "utf8")).toBe("tests passed\n")
    const told = of(log, "inbox.enqueued").at(-1)!.data
    expect(told.origin).toBe("background_command")
    const text = told.content[0]?.type === "text" ? told.content[0].text : ""
    expect(text).toMatch(/^Background command bg_[0-9a-f]{8} exited with code 3 after \d+(\.\d)? s\.\nCommand: sleep 0\.4; echo tests passed; exit 3\nOutput:\ntests passed\nFull output: /)
    expect(of(log, "execution.started")).toHaveLength(2)
    expect(provider.remaining).toBe(0)
  })

  test("is stopped, with everything it started, by the stop tool and when the session is closed", async () => {
    const { data, workspace } = place("wl-bg-")
    const directory = workspace("w")
    const command = "echo $$ > own.pid; sleep 300 & echo $! > child.pid; echo started; wait"
    const stopId = (request: ModelRequest) => {
      const last = request.input.findLast((item) => item.type === "tool_result")
      return /as (bg_[0-9a-f]+)/.exec(last?.type === "tool_result" ? last.output : "")?.[1] ?? "?"
    }
    const responses: ScriptedResponse[] = [
      [call("shell", { command, background: true })],
      (request) => [call("background_output", { id: stopId(request) })],
      (request) => [call("background_stop", { id: /(bg_[0-9a-f]+) is still/.exec(JSON.stringify(request.input.at(-1)))?.[1] ?? "?" })],
      say("Stopped."),
      [call("shell", { command: "echo $$ > second.pid; sleep 300", background: true })],
      say("Left running."),
    ]
    const { harness } = start(data, responses)
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Start it, look, stop it.")
    await until(() => existsSync(join(directory, "child.pid")))
    const pids = ["own.pid", "child.pid"].map((name) => Number(readFileSync(join(directory, name), "utf8")))
    await session.settled()
    const outputs = of(session.readEvents(), "tool.settled").map((item) => item.data.output)
    expect(outputs[1]).toMatch(/^bg_[0-9a-f]{8} is still running\.\nOutput so far:\nstarted$/)
    expect(outputs[2]).toMatch(/^Background command bg_[0-9a-f]{8} was stopped \(it was asked to stop\) after /)
    expect(pids.map(alive)).toEqual([false, false])
    expect(of(session.readEvents(), "spawn.ended")[0]!.data.outcome).toBe("stopped")

    session.send("Start another and leave it.")
    await session.settled()
    await until(() => existsSync(join(directory, "second.pid")))
    const second = Number(readFileSync(join(directory, "second.pid"), "utf8"))
    expect(alive(second)).toBe(true)
    const id = session.id
    await session.close()
    expect(alive(second)).toBe(false)
    const ended = of(harness.engine.readEvents(id), "spawn.ended").at(-1)!
    expect(ended.data).toMatchObject({ outcome: "stopped" })
    expect(ended.data.detail).toContain("the harness shut down")
  })
})

describe("subagents in git worktrees", () => {
  function repository() {
    const spot = place("wl-wt-")
    const directory = spot.workspace("repo", { "a.txt": "a1\n", "b.txt": "b1\n", "shared.txt": "line 1\nline 2\nline 3\n", ".gitignore": "ignored/\n" })
    sh(directory, "git init -q -b main && git add -A && git commit -q -m first")
    // The user's own state: an uncommitted edit, something staged, an untracked file, a stash.
    writeFileSync(join(directory, "stashed.txt"), "stash me\n")
    sh(directory, "git add stashed.txt && git stash -q && echo staged > staged.txt && git add staged.txt")
    writeFileSync(join(directory, "a.txt"), "a1 edited by the user\n")
    writeFileSync(join(directory, "untracked.txt"), "new\n")
    const state = () => ({
      head: sh(directory, "git rev-parse HEAD").trim(),
      branches: sh(directory, "git branch --list").trim(),
      index: sh(directory, "git diff --cached --name-status").trim(),
      stash: sh(directory, "git stash list").trim(),
      worktrees: sh(directory, "git worktree list --porcelain | grep -c '^worktree '").trim(),
    })
    return { ...spot, directory, state }
  }
  /** The model per conversation: the parent and each child are told apart by their first prompt. */
  const converse = (scripts: Record<string, ScriptedResponse[]>): ScriptedResponse[] => {
    const next: ScriptedResponse = (request, index) => {
      const first = request.input.find((item) => item.type === "message" && item.role === "user")
      const prompt = first?.type === "message" && first.content[0]?.type === "text" ? first.content[0].text : ""
      const key = Object.keys(scripts).find((candidate) => prompt.startsWith(candidate))
      const response = key === undefined ? undefined : scripts[key]!.shift()
      if (response === undefined) throw new Error(`no response scripted for ${JSON.stringify(prompt.slice(0, 40))}`)
      return typeof response === "function" ? response(request, index) : response
    }
    return Array.from({ length: Object.values(scripts).reduce((sum, list) => sum + list.length, 0) }, () => next)
  }

  test("each works on its own branch from the workspace as it stands; their changes are merged back into the working tree and nothing else of the repository changes", async () => {
    const { data, directory, state } = repository()
    const before = state()
    const { harness, logged } = start(
      data,
      converse({
        "Fix both": [[call("subagent", { task: "Fix a", worktree: true }, "call_1"), call("subagent", { task: "Fix b", worktree: true }, "call_2")], say("Both merged.")],
        // It sees the user's uncommitted edit, edits another line of the shared file, and commits by itself.
        "Fix a": [[call("shell", { command: "cat a.txt untracked.txt && sed -i.bak 's/line 1/line one/' shared.txt && rm shared.txt.bak && echo a2 >> a.txt && git add -A && git -c user.name=child -c user.email=child@localhost commit -q -m 'child commit' && pwd" })], say("a is fixed.")],
        // It leaves its changes uncommitted, adds a file and removes one.
        "Fix b": [[call("write", { path: "b.txt", content: "b2\n" }, "call_1"), call("write", { path: "sub/new.txt", content: "new\n" }, "call_2"), call("shell", { command: "sed -i.bak 's/line 3/line three/' shared.txt && rm shared.txt.bak untracked.txt" }, "call_3")], say("b is fixed.")],
      }),
    )
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Fix both, each in its own worktree.")
    await session.settled()
    const log = session.readEvents()
    const ended = of(log, "spawn.ended")
    // Should a subagent not end merged, say what each call returned and what the harness logged.
    if (ended.length !== 2 || ended.some((item) => item.data.merge?.status !== "merged"))
      console.error(`spawn-real: the parent's results:\n${of(log, "tool.settled").map((item) => `- ${item.data.outcome}: ${item.data.output}`).join("\n")}\nended: ${JSON.stringify(ended.map((item) => item.data))}\nlogged:\n${logged.join("\n")}`)
    expect(ended.map((item) => item.data.merge?.status)).toEqual(["merged", "merged"])
    expect(ended.flatMap((item) => item.data.merge!.files).sort()).toEqual(["a.txt", "b.txt", "shared.txt", "shared.txt", "sub/new.txt", "untracked.txt"])
    // Both sets of changes are in the working tree, the shared file merged line by line.
    expect(readFileSync(join(directory, "a.txt"), "utf8")).toBe("a1 edited by the user\na2\n")
    expect(readFileSync(join(directory, "b.txt"), "utf8")).toBe("b2\n")
    expect(readFileSync(join(directory, "shared.txt"), "utf8")).toBe("line one\nline 2\nline three\n")
    expect(readFileSync(join(directory, "sub/new.txt"), "utf8")).toBe("new\n")
    expect(existsSync(join(directory, "untracked.txt"))).toBe(false)
    // The user's branch, index, stash and worktree list are what they were; the harness's branches and worktrees are gone.
    expect(state()).toEqual(before)
    const children = of(log, "spawn.started").map((item) => (item.data.work.kind === "subagent" ? item.data.work : null)!)
    for (const child of children) {
      expect(existsSync(child.worktree!.path)).toBe(false)
      expect(child.worktree!.repository).toBe(directory)
      expect(harness.engine.getSession(child.sessionId)!.session.cwd).toBe(child.worktree!.path)
    }
    // The children are the harness's own sessions: the default listing shows the parent only.
    expect(harness.engine.listSessions().map((summary) => summary.session.id)).toEqual([session.id])
    expect(harness.engine.listSessions({ includeSpawned: true })).toHaveLength(3)
    // The child worked in its worktree, not in the parent's directory, and started from the workspace as it stood.
    const fixedA = children.find((child) => harness.engine.getSession(child.sessionId)!.session.title === "Fix a")!
    expect(of(harness.engine.readEvents(fixedA.sessionId), "tool.settled")[0]!.data.output).toBe(`a1 edited by the user\nnew\n${fixedA.worktree!.path}\n`)
    const results = of(log, "tool.settled").map((item) => item.data.output)
    expect(results.every((output) => /Worktree: Its changes to \d files? were merged into this workspace/.test(output))).toBe(true)
  })

  test("a conflict is reported and nothing is merged: the workspace is as it was, and the work stays on the child's branch", async () => {
    const { data, directory, state } = repository()
    const before = state()
    let edited = false
    const { harness } = start(
      data,
      converse({
        "Fix it": [[call("subagent", { task: "Rewrite line 2", worktree: true })], say("It conflicted.")],
        "Rewrite line 2": [
          () => {
            // While the child works, the parent's workspace changes the same line.
            writeFileSync(join(directory, "shared.txt"), "line 1\nline 2 by the parent\nline 3\n")
            edited = true
            return [call("shell", { command: "sed -i.bak 's/line 2/line two by the child/' shared.txt && rm shared.txt.bak && echo extra > extra.txt" })]
          },
          say("Rewrote it."),
        ],
      }),
    )
    const session = harness.engine.createSession({ cwd: directory, settings: SETTINGS })
    session.send("Fix it in a worktree.")
    await session.settled()
    expect(edited).toBe(true)
    const merge = of(session.readEvents(), "spawn.ended")[0]!.data.merge!
    expect(merge).toMatchObject({ status: "conflicts", conflicts: ["shared.txt"], files: ["extra.txt", "shared.txt"], kept: true })
    // Nothing of the child's work reached the workspace, not even the file that did not conflict.
    expect(readFileSync(join(directory, "shared.txt"), "utf8")).toBe("line 1\nline 2 by the parent\nline 3\n")
    expect(existsSync(join(directory, "extra.txt"))).toBe(false)
    // The work is kept where the model (or the user) can get it: on the child's branch, as a commit.
    const after = state()
    expect(after.branches).toContain(merge.branch)
    expect({ ...after, branches: before.branches }).toEqual(before)
    expect(sh(directory, `git show ${merge.commit}:shared.txt`)).toBe("line 1\nline two by the child\nline 3\n")
    const output = of(session.readEvents(), "tool.settled")[0]!.data.output
    expect(output).toContain("Worktree: Its work was NOT merged: shared.txt was also changed in this workspace since it started")
    expect(output).toContain(`on branch ${merge.branch}`)
    sh(directory, `git branch -D ${merge.branch}`)
  })

  test("outside a git repository the worktree is refused with the reason, and nothing is started", async () => {
    const { data, workspace } = place("wl-wt-")
    const { harness } = start(data, [[call("subagent", { task: "Fix a", worktree: true })], say("No repository.")])
    const session = harness.engine.createSession({ cwd: workspace("plain"), settings: SETTINGS })
    session.send("Fix it in a worktree.")
    await session.settled()
    expect(of(session.readEvents(), "tool.settled")[0]!.data).toMatchObject({ outcome: "error" })
    expect(of(session.readEvents(), "tool.settled")[0]!.data.output).toContain("the working directory is not in a git repository")
    expect(of(session.readEvents(), "spawn.started")).toEqual([])
    expect(harness.engine.listSessions().map((summary) => summary.session.id)).toEqual([session.id as SessionId])
  })
})
