/**
 * The note a sandboxed command's result gets, with real commands in the real
 * sandbox: a change to the repository's git configuration or hooks, which
 * stays refused whatever access is granted, and a network failure that a
 * pipeline or `|| true` hid from the exit code.
 *
 * Skipped, visibly, where bubblewrap cannot run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { sandboxHint } from "../../src/approval/escalation.ts"
import type { CallId, MessageId, SessionId } from "../../src/id.ts"
import { createCommandSandbox } from "../../src/sandbox/command.ts"
import { type SandboxRun, noBlobStore } from "../../src/tool/tool.ts"
import { shellTool } from "../../src/tools/shell.ts"
import { removeTempDirs, skipReason, tempDir } from "./helpers.ts"

afterAll(removeTempDirs)

const NOTHING: SandboxRun = { network: false, writableRoots: [] }
const SESSION = "ses_hints" as SessionId
const base = tempDir("hints")
const sandbox = createCommandSandbox({ tempBase: join(base, "session-temp") })
const tool = shellTool({ spillDir: join(base, "spill"), sandbox, graceMs: 500 })
let calls = 0

/** Runs a command through the shell tool as the step loop does, and adds the note as the step loop does before storing. */
async function sh(cwd: string, command: string, access: SandboxRun = NOTHING) {
  const result = await tool.execute(
    { command, timeout: 60 },
    { sessionId: SESSION, messageId: "msg_1" as MessageId, callId: `call_${++calls}` as CallId, cwd, signal: new AbortController().signal, progress: () => {}, putBlob: noBlobStore, sandbox: access },
  )
  const exitCode = (result.display as { exitCode: number | null }).exitCode
  return { output: result.output, exitCode, hint: sandboxHint({ sandboxed: true, network: access.network, exitCode, output: result.output }) }
}

function host(cwd: string, command: string) {
  const done = Bun.spawnSync(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } })
  return { code: done.exitCode, output: done.stdout.toString() + done.stderr.toString() }
}

describe.skipIf(skipReason !== null)("git configuration and hooks stay read-only, and the note says so", () => {
  let repo = ""
  let config = ""
  beforeAll(() => {
    repo = join(base, "repo")
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, "a.txt"), "a\n")
    expect(host(repo, "git init -q . && git add -A && git -c user.email=a@example.com -c user.name=a commit -qm init").code).toBe(0)
    config = readFileSync(join(repo, ".git", "config"), "utf8")
  })

  const unchanged = () => {
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toBe(config)
    expect(readdirSync(join(repo, ".git", "hooks")).some((name) => !name.endsWith(".sample"))).toBe(false)
  }

  // Ordinary local work that writes the configuration: refused, with a note that says why and what to do instead.
  for (const command of ["git config user.name someone", "git remote add origin https://example.com/r.git", "git config branch.master.remote origin"])
    test(command, async () => {
      const result = await sh(repo, command)
      expect(result.exitCode).not.toBe(0)
      expect(result.output).toContain("Device or resource busy")
      expect(result.hint?.suspects).toEqual(["git"])
      expect(result.hint?.note).toContain("git -c user.name=<name> -c user.email=<email> commit")
      expect(result.hint?.note).toContain("ask them to run it themselves")
      unchanged()
    })

  // Every key whose value git runs, or that changes what a later git command outside the sandbox does. Inert values:
  // what is tested is that the write is refused, not what the value would do.
  const keys = [
    "core.hooksPath",
    "core.fsmonitor",
    "core.sshCommand",
    "core.pager",
    "core.editor",
    "core.askPass",
    "sequence.editor",
    "alias.st",
    "url.https://example.com/.insteadOf",
    "filter.x.clean",
    "filter.x.smudge",
    "diff.x.textconv",
    "diff.external",
    "merge.x.driver",
    "include.path",
    "includeIf.gitdir:/.path",
    "credential.helper",
    "gpg.program",
    "extensions.worktreeConfig",
  ]
  test("each key that names a program or another configuration is refused", async () => {
    for (const key of keys) {
      const result = await sh(repo, `git config ${JSON.stringify(key)} true`)
      expect(result.exitCode, key).not.toBe(0)
      expect(result.hint?.suspects, key).toEqual(["git"])
    }
    unchanged()
  })

  test("a hook written directly, as a hook installer does, is refused and the note says why", async () => {
    const result = await sh(repo, "printf 'exit 0\\n' > .git/hooks/pre-commit")
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("Read-only file system")
    // Not "ask for writes": no write access granted would change it.
    expect(result.hint?.suspects).toEqual(["git"])
    unchanged()
  })

  test("granting writes does not open them", async () => {
    const result = await sh(repo, "git config user.name someone", { network: false, writableRoots: [join(repo, ".git")] })
    expect(result.exitCode).not.toBe(0)
    unchanged()
  })

  test("reading the configuration and a commit with the identity on the command line work", async () => {
    expect((await sh(repo, "git config --get core.bare")).output).toBe("false\n")
    writeFileSync(join(repo, "b.txt"), "b\n")
    const commit = await sh(repo, "git add b.txt && git -c user.name=agent -c user.email=agent@example.com commit -qm b && git log --format=%an -1")
    expect(commit.output).toBe("agent\n")
    expect(commit.hint).toBeNull()
  })
})

describe.skipIf(skipReason !== null)("a network failure hidden by a pipeline still gets the note", () => {
  let workspace = ""
  beforeAll(() => {
    workspace = join(base, "net")
    mkdirSync(workspace, { recursive: true })
  })

  const shapes: [string, string][] = [
    ["curl", "curl -sS https://example.com | head -3"],
    ["curl", "curl -sS https://example.com 2>&1 | cat"],
    ["npm", "npm view left-pad version --fetch-retries=0 2>&1 | cat"],
    ["git", "git ls-remote https://example.com/r.git 2>&1 || true"],
    ["python3", "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\")' 2>&1 | tail -1"],
    ["wget", "wget https://example.com 2>&1 | cat"],
  ]
  for (const [program, command] of shapes)
    test.skipIf(Bun.which(program) === null)(command, async () => {
      const result = await sh(workspace, command)
      expect(result.exitCode).toBe(0)
      expect(result.hint?.suspects).toEqual(["network"])
      expect(result.hint?.note).toContain('`sandbox: { "network": true }`')
      expect(result.hint?.note).toContain("although it exited 0")
    }, 30_000)

  test("output that only mentions DNS, a lookup error code or the message in source code gets no note", async () => {
    writeFileSync(
      join(workspace, "net.ts"),
      'if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") retry()\nthrow new Error(`Could not resolve host: ${host}`)\n// getaddrinfo EAI_AGAIN means the DNS lookup timed out\nlog("Temporary failure in name resolution")\n',
    )
    const result = await sh(workspace, "cat net.ts; grep -n ENOTFOUND net.ts; echo 'DNS lookup ok' | cat")
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("ENOTFOUND")
    expect(result.hint).toBeNull()
  })

  test("a command that swallows the error and prints nothing still gets no note: there is nothing to read", async () => {
    const result = await sh(workspace, "curl -s https://example.com | cat")
    expect(result.output).toBe("(no output)")
    expect(result.hint).toBeNull()
  })
})
