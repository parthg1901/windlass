/**
 * Real processes under bubblewrap. Every test spawns the sandbox the way the
 * shell tool will: detached, with the planned argv, env and cwd.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { type SandboxPolicy, defaultPolicy, sandboxCommand } from "../../src/sandbox/index.ts"
import { descendants, isRunning, plan, removeTempDirs, run, skipReason, spawnPlan, tempDir, waitUntil } from "./helpers.ts"

afterEach(removeTempDirs)

const title = skipReason ? `bwrap backend (SKIPPED: ${skipReason})` : "bwrap backend"

/** A workspace, a sibling directory outside it, and a fake home holding credentials. */
function fixture(overrides: Partial<SandboxPolicy> = {}) {
  const root = tempDir("fs")
  const workspace = join(root, "workspace")
  const outside = join(root, "outside")
  const home = join(root, "home")
  mkdirSync(workspace)
  mkdirSync(outside)
  mkdirSync(join(home, ".ssh"), { recursive: true })
  mkdirSync(join(home, ".local", "share", brand.directory), { recursive: true })
  writeFileSync(join(home, ".ssh", "id_ed25519"), "SSH-PRIVATE-KEY-MATERIAL\n")
  writeFileSync(join(home, ".netrc"), "machine example.com password NETRC-PASSWORD\n")
  writeFileSync(join(home, ".local", "share", brand.directory, "auth.json"), '{"token":"HARNESS-AUTH-TOKEN"}\n')
  writeFileSync(join(home, "notes.txt"), "ordinary file\n")
  const policy = { ...defaultPolicy({ workspace, home, env: {} }), ...overrides }
  return { root, workspace, outside, home, policy }
}

describe.skipIf(skipReason !== null)(title, () => {
  describe("filesystem", () => {
    test("a write inside the workspace succeeds", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "echo hello > made.txt && mkdir -p sub/deep && echo nested > sub/deep/file", f.workspace))
      expect(result).toMatchObject({ code: 0, stderr: "" })
      expect(readFileSync(join(f.workspace, "made.txt"), "utf8")).toBe("hello\n")
      expect(readFileSync(join(f.workspace, "sub", "deep", "file"), "utf8")).toBe("nested\n")
    })

    test("a write outside the workspace fails and leaves nothing behind", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `echo pwned > ${f.outside}/direct; echo pwned > ../outside/relative; touch ${f.home}/in-home`, f.workspace))
      expect(result.stderr).toContain("Read-only file system")
      expect(existsSync(join(f.outside, "direct"))).toBe(false)
      expect(existsSync(join(f.outside, "relative"))).toBe(false)
      expect(existsSync(join(f.home, "in-home"))).toBe(false)
    })

    test("a relative symlink inside the workspace cannot be used to write outside it", async () => {
      const f = fixture()
      writeFileSync(join(f.outside, "existing.txt"), "original\n")
      symlinkSync("../outside", join(f.workspace, "escape-dir"))
      symlinkSync("../outside/existing.txt", join(f.workspace, "escape-file"))
      const result = await run(
        plan(f.policy, "echo pwned > escape-dir/new; echo pwned > escape-file; ln -s ../outside made-inside && echo pwned > made-inside/new2; echo done", f.workspace),
      )
      expect(result.stdout).toBe("done\n")
      expect(result.stderr.match(/Read-only file system/g)?.length).toBe(3)
      expect(existsSync(join(f.outside, "new"))).toBe(false)
      expect(existsSync(join(f.outside, "new2"))).toBe(false)
      expect(readFileSync(join(f.outside, "existing.txt"), "utf8")).toBe("original\n")
    })

    test("hidden paths cannot be read or listed, including the harness data directory", async () => {
      const f = fixture()
      const result = await run(
        plan(
          f.policy,
          `cat ${f.home}/.ssh/id_ed25519; ls ${f.home}/.ssh; cat ${f.home}/.netrc; cat ${f.home}/.local/share/${brand.directory}/auth.json; echo exit-ok`,
          f.workspace,
        ),
      )
      expect(result.stdout).toBe("exit-ok\n")
      expect(result.stderr.match(/Permission denied/g)?.length).toBe(4)
      for (const secret of ["SSH-PRIVATE-KEY-MATERIAL", "NETRC-PASSWORD", "HARNESS-AUTH-TOKEN"]) expect(result.stdout + result.stderr).not.toContain(secret)
    })

    test("a hidden path inside a writable root stays hidden and unwritable", async () => {
      const f = fixture()
      writeFileSync(join(f.workspace, ".env"), "API_KEY=WORKSPACE-SECRET\n")
      const policy = { ...f.policy, hiddenPaths: [...f.policy.hiddenPaths, join(f.workspace, ".env")] }
      const result = await run(plan(policy, "cat .env; echo overwrite > .env; echo exit-ok", f.workspace))
      expect(result.stdout).toBe("exit-ok\n")
      expect(result.stdout + result.stderr).not.toContain("WORKSPACE-SECRET")
      expect(readFileSync(join(f.workspace, ".env"), "utf8")).toBe("API_KEY=WORKSPACE-SECRET\n")
    })

    test("ordinary files outside the workspace stay readable", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `head -1 /etc/passwd; cat ${f.home}/notes.txt`, f.workspace))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${readFileSync("/etc/passwd", "utf8").split("\n")[0]}\nordinary file\n`)
    })

    test("with readRest off, only system directories and the workspace are readable", async () => {
      const f = fixture({ readRest: false })
      writeFileSync(join(f.workspace, "mine.txt"), "workspace file\n")
      const result = await run(plan(f.policy, `cat mine.txt; /usr/bin/true && echo system-ok; cat ${f.home}/notes.txt`, f.workspace))
      expect(result.stdout).toBe("workspace file\nsystem-ok\n")
      expect(result.stderr).toContain("No such file or directory")
    })

    test("/tmp is private and empty unless a temp root is given", async () => {
      const f = fixture()
      const marker = `marker-${crypto.randomUUID()}`
      const first = await run(plan(f.policy, `ls -A /tmp | wc -l; echo x > /tmp/${marker} && echo wrote`, f.workspace))
      expect(first.stdout).toBe("0\nwrote\n")
      expect(existsSync(join("/tmp", marker))).toBe(false)
      expect((await run(plan(f.policy, `test -e /tmp/${marker} && echo leaked || echo gone`, f.workspace))).stdout).toBe("gone\n")

      const tempRoot = join(f.root, "tmp")
      mkdirSync(tempRoot)
      const withRoot = await run(plan({ ...f.policy, tempRoot }, `echo kept > /tmp/${marker}; echo "$TMPDIR"`, f.workspace))
      expect(withRoot.stdout).toBe("/tmp\n")
      expect(readFileSync(join(tempRoot, marker), "utf8")).toBe("kept\n")
    })
  })

  describe("network", () => {
    const listener = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { open: (socket) => void socket.end("hello from host\n"), data: () => {} } })
    afterAll(() => listener.stop(true))
    const hostAddress = Object.values(networkInterfaces())
      .flat()
      .find((address) => address && address.family === "IPv4" && !address.internal)?.address
    const connect = (address: string) => `exec 3<>/dev/tcp/${address}/${listener.port} && head -1 <&3 || echo "connect to ${address} failed"`

    test("off: TCP to a listener on the host fails, over loopback and the host's address", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, [connect("127.0.0.1"), ...(hostAddress ? [connect(hostAddress)] : [])].join("; "), f.workspace))
      expect(result.stdout).toBe(["connect to 127.0.0.1 failed\n", ...(hostAddress ? [`connect to ${hostAddress} failed\n`] : [])].join(""))
    })

    test("off: DNS fails", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "getent hosts example.com || echo dns-failed", f.workspace))
      expect(result.stdout).toBe("dns-failed\n")
    })

    test("on: TCP to the host listener succeeds", async () => {
      const f = fixture({ network: { mode: "on" } })
      const result = await run(plan(f.policy, connect("127.0.0.1"), f.workspace))
      expect(result.stdout).toBe("hello from host\n")
    })

    test("on: DNS resolves whenever it resolves outside the sandbox", async () => {
      const f = fixture({ network: { mode: "on" } })
      const host = Bun.spawnSync(["getent", "hosts", "example.com"], { stdout: "pipe" })
      if (host.exitCode !== 0) return console.warn("[sandbox tests] DNS does not work outside the sandbox here; skipping the network-on DNS check")
      const result = await run(plan(f.policy, "getent hosts example.com >/dev/null && echo resolved", f.workspace))
      expect(result.stdout).toBe("resolved\n")
    })
  })

  describe("process", () => {
    test("exit code, stdout and stderr pass through unchanged", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "printf 'out line\\n'; printf 'err line\\n' >&2; printf 'no newline'; exit 42", f.workspace))
      expect(result).toEqual({ stdout: "out line\nno newline", stderr: "err line\n", code: 42, signal: null })
    })

    test("a command killed by a signal is reported as exit code 128+n, not as a signal", async () => {
      const f = fixture()
      expect(await run(plan(f.policy, "kill -KILL $$", f.workspace))).toMatchObject({ code: 137, signal: null })
    })

    test("SIGTERM to the group gives the command its grace period, and every descendant is gone afterwards", async () => {
      const f = fixture()
      const child = spawnPlan(
        plan(
          f.policy,
          [
            `trap 'echo cleaned > cleanup-ran; exit 3' TERM`,
            // a child that ignores SIGTERM, with a grandchild that inherits the ignore
            `bash -c 'trap "" TERM; sleep 300 & wait' &`,
            // a process that leaves the process group entirely
            "setsid sleep 300 &",
            "sleep 300 &",
            "echo ready",
            "wait",
          ].join("\n"),
          f.workspace,
        ),
      )
      const pids = await readyThenDescendants(child)
      expect(pids.length).toBeGreaterThanOrEqual(6)

      process.kill(-child.pid, "SIGTERM")
      expect(await child.exited).toBe(3)
      expect(readFileSync(join(f.workspace, "cleanup-ran"), "utf8")).toBe("cleaned\n")
      expect(await waitUntil(() => !pids.some(isRunning), 2000)).toBe(true)
    })

    test("SIGKILL to the group kills a tree that ignores SIGTERM, including a setsid escapee", async () => {
      const f = fixture()
      const child = spawnPlan(plan(f.policy, `trap '' TERM\nbash -c 'sleep 300 & wait' &\nsetsid sleep 300 &\necho ready\nwait`, f.workspace))
      const pids = await readyThenDescendants(child)

      process.kill(-child.pid, "SIGTERM")
      await Bun.sleep(300)
      // Nothing died: the sandbox did not turn SIGTERM into an immediate kill.
      expect(pids.filter(isRunning)).toEqual(pids)

      process.kill(-child.pid, "SIGKILL")
      await child.exited
      expect(await waitUntil(() => !pids.some(isRunning), 2000)).toBe(true)
    })

    test("the sandbox sees only its own processes", async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `ls /proc | grep -cE '^[0-9]+$'; test -e /proc/${process.pid} && echo visible || echo invisible`, f.workspace))
      expect(Number(result.stdout.split("\n")[0])).toBeLessThan(10)
      expect(result.stdout.split("\n")[1]).toBe("invisible")
    })
  })

  describe("environment", () => {
    test("credential-looking variables do not reach the child", async () => {
      const f = fixture()
      const env = {
        PATH: process.env.PATH,
        HOME: f.home,
        GITHUB_TOKEN: "ghp_secret",
        OPENAI_API_KEY: "sk-openai",
        ANTHROPIC_BASE_URL: "https://proxy.example",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_REGION: "eu-west-1",
        DB_PASSWORD: "hunter2",
        CLIENT_SECRET: "s3cret",
        SSH_AUTH_SOCK: "/run/agent.sock",
        DATABASE_URL: "postgres://user:pw@db/app",
        SAFE_SETTING: "visible",
        GIT_AUTHOR_NAME: "Someone",
      }
      const result = await run(plan(f.policy, "env | cut -d= -f1 | sort", f.workspace, env))
      const names = result.stdout.trim().split("\n")
      expect(names).toEqual(expect.arrayContaining(["GIT_AUTHOR_NAME", "HOME", "PATH", "SAFE_SETTING", "TMPDIR"]))
      for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "AWS_ACCESS_KEY_ID", "AWS_REGION", "DB_PASSWORD", "CLIENT_SECRET", "SSH_AUTH_SOCK", "DATABASE_URL"])
        expect(names).not.toContain(name)
    })
  })

  describe("escapes through host services", () => {
    const uid = process.getuid?.() ?? 0
    const userManager = Bun.which("systemd-run") && Bun.spawnSync(["systemd-run", "--user", "--wait", "-q", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0

    test.skipIf(!userManager)(`systemd-run --user cannot start a unit outside the sandbox${userManager ? "" : " (SKIPPED: no reachable systemd user manager)"}`, async () => {
      const f = fixture()
      const result = await run(plan(f.policy, `XDG_RUNTIME_DIR=/run/user/${uid} systemd-run --user --wait -q true && echo escaped || echo blocked`, f.workspace, { PATH: process.env.PATH }))
      expect(result.stdout).toBe("blocked\n")
    })

    const dockerReachable = existsSync("/run/docker.sock") && Bun.which("curl") && Bun.spawnSync(["curl", "-s", "-m", "3", "--unix-socket", "/run/docker.sock", "http://docker/_ping"]).exitCode === 0
    test.skipIf(!dockerReachable)(`the Docker socket is unreachable${dockerReachable ? "" : " (SKIPPED: no reachable Docker socket on this host)"}`, async () => {
      const f = fixture()
      const result = await run(plan(f.policy, "curl -s -m 3 --unix-socket /var/run/docker.sock http://docker/_ping && echo escaped || echo blocked", f.workspace))
      expect(result.stdout).toBe("blocked\n")
    })
  })

  test("overhead: median of 20 runs of `true`", async () => {
    const f = fixture()
    const trueArgv = ["/usr/bin/true"]
    const sandboxed = sandboxCommand(f.policy, { argv: trueArgv, cwd: f.workspace })
    if (sandboxed.kind !== "ready") throw new Error(sandboxed.reason)
    const time = async (argv: string[]) => {
      const samples: number[] = []
      for (let i = 0; i < 20; i++) {
        const start = performance.now()
        const child = Bun.spawn(argv, { env: sandboxed.env, cwd: f.workspace, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" })
        expect(await child.exited).toBe(0)
        samples.push(performance.now() - start)
      }
      return samples.sort((a, b) => a - b)[10] ?? 0
    }
    const bare = await time(trueArgv)
    const inSandbox = await time(sandboxed.argv)
    console.log(`[sandbox overhead] true: ${bare.toFixed(2)} ms bare, ${inSandbox.toFixed(2)} ms sandboxed, +${(inSandbox - bare).toFixed(2)} ms per command (median of 20)`)
    expect(inSandbox).toBeLessThan(1000)
  })
})

/** Waits for the command's "ready" line, then lists its host-side process tree. */
async function readyThenDescendants(child: ReturnType<typeof spawnPlan>) {
  const reader = child.stdout.getReader()
  let seen = ""
  while (!seen.includes("ready")) {
    const next = await reader.read()
    if (next.done) throw new Error(`exited before ready: ${seen}`)
    seen += new TextDecoder().decode(next.value)
  }
  reader.releaseLock()
  // Background jobs may still be forking; let the tree settle.
  await Bun.sleep(200)
  return descendants(child.pid)
}
