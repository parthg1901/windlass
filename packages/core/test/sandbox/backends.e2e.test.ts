/** The generated bwrap argv and Seatbelt profile, checked as text. No process is spawned. */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type SandboxPolicy, defaultPolicy, sandboxCommand, seatbeltProfile } from "../../src/sandbox/index.ts"
import { bwrapArgv } from "../../src/sandbox/bwrap.ts"
import { removeTempDirs, tempDir } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(removeTempDirs)

function layout() {
  const root = realpathSync(tempDir("args"))
  const workspace = join(root, "ws")
  mkdirSync(join(workspace, "secret-dir"), { recursive: true })
  writeFileSync(join(workspace, "secret-file"), "")
  symlinkSync(join(workspace, "secret-dir"), join(root, "link-to-secret"))
  const policy: SandboxPolicy = {
    writableRoots: [workspace, join(root, "missing")],
    readRest: true,
    hiddenPaths: [join(workspace, "secret-dir"), join(workspace, "secret-dir", "nested"), join(workspace, "secret-file"), join(root, "link-to-secret"), join(root, "absent")],
    network: { mode: "off" },
    env: { mode: "deny" },
  }
  return { root, workspace, policy }
}

const options = { bwrapPath: "/usr/bin/bwrap", envPath: "/usr/bin/env", maskFile: "/mask" }

describe("bwrap argv", () => {
  test("namespaces, mounts in order, hidden paths last, command behind the signal trampoline", () => {
    const l = layout()
    const argv = bwrapArgv(l.policy, ["bash", "-c", "make"], l.workspace, options)
    expect(argv).toEqual([
      "/usr/bin/env",
      "--ignore-signal=TERM,INT,HUP",
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--unshare-user-try",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      l.workspace,
      l.workspace,
      // the symlinked duplicate and the nested path collapse into one mask; the missing paths are skipped
      "--perms",
      "0000",
      "--tmpfs",
      join(l.workspace, "secret-dir"),
      "--ro-bind",
      "/mask",
      join(l.workspace, "secret-file"),
      "--chdir",
      l.workspace,
      "--",
      "/usr/bin/env",
      "--default-signal=TERM,INT,HUP",
      "bash",
      "-c",
      "make",
    ])
    expect(argv).not.toContain("--new-session")
  })

  test("network on keeps the host network; a temp root replaces the private /tmp", () => {
    const l = layout()
    const tempRoot = join(l.root, "tmp")
    mkdirSync(tempRoot)
    const argv = bwrapArgv({ ...l.policy, network: { mode: "on" }, tempRoot }, ["true"], l.workspace, options)
    expect(argv).not.toContain("--unshare-net")
    expect(argv.join(" ")).toContain(`--bind ${tempRoot} /tmp`)
    expect(argv).not.toContain("--tmpfs /tmp")
  })

  test("without GNU env the command runs directly under bwrap", () => {
    const l = layout()
    const argv = bwrapArgv(l.policy, ["true"], l.workspace, { ...options, envPath: null })
    expect(argv[0]).toBe("/usr/bin/bwrap")
    expect(argv.slice(argv.indexOf("--"))).toEqual(["--", "true"])
  })

  test("readRest off binds only system paths and readable roots, keeping merged-/usr symlinks", () => {
    const l = layout()
    const argv = bwrapArgv({ ...l.policy, readRest: false, readableRoots: [l.root] }, ["true"], l.workspace, options)
    expect(argv.join(" ")).not.toContain("--ro-bind / /")
    expect(argv.join(" ")).toContain("--ro-bind /usr /usr")
    expect(argv.join(" ")).toContain(`--ro-bind ${l.root} ${l.root}`)
  })
})

describe("seatbelt profile (generated on Linux; untested on a real Mac)", () => {
  const policy: SandboxPolicy = {
    writableRoots: ["/Users/u/project"],
    tempRoot: "/Users/u/.cache/session-tmp",
    readRest: true,
    hiddenPaths: ["/Users/u/.ssh", "/Users/u/Library/Keychains"],
    network: { mode: "off" },
    env: { mode: "deny" },
  }

  test("deny by default, read everything, write the roots, hidden denials last", () => {
    const generated = seatbeltProfile(policy)
    expect(generated.params).toEqual([
      ["WRITABLE_0", "/Users/u/project"],
      ["WRITABLE_1", "/Users/u/.cache/session-tmp"],
      ["HIDDEN_0", "/Users/u/.ssh"],
      ["HIDDEN_1", "/Users/u/Library/Keychains"],
    ])
    const text = generated.profile
    expect(text).toContain("UNTESTED ON A REAL MAC")
    expect(text).toStartWith("; Generated")
    expect(text).toContain("(version 1)\n(deny default)")
    expect(text).toContain("(allow file-read*)")
    expect(text).toContain('(allow file-read* file-write*\n  (subpath (param "WRITABLE_0"))\n  (subpath (param "WRITABLE_1")))')
    expect(text).toContain('(deny file-read* file-write*\n  (subpath (param "HIDDEN_0"))\n  (subpath (param "HIDDEN_1")))')
    expect(text.indexOf("(deny file-read* file-write*")).toBeGreaterThan(text.indexOf('(param "WRITABLE_1")'))
    expect(text).not.toContain("(allow network")
    expect(text).not.toContain("/Users/u")
    // balanced parentheses outside comments and strings
    const code = text.replace(/;.*$/gm, "").replace(/"[^"]*"/g, "")
    expect(code.split("(").length).toBe(code.split(")").length)
  })

  test("network on allows the network and the DNS/TLS services", () => {
    const text = seatbeltProfile({ ...policy, network: { mode: "on" } }).profile
    expect(text).toContain("(allow network*)")
    expect(text).toContain('(global-name "com.apple.trustd.agent")')
  })

  test("readRest off lists readable locations instead of allowing all reads", () => {
    const generated = seatbeltProfile({ ...policy, readRest: false, readableRoots: ["/Users/u/shared"] })
    expect(generated.profile).not.toContain("(allow file-read*)\n")
    expect(generated.params).toEqual(expect.arrayContaining([["READABLE_0", "/usr"], ["READABLE_12", "/Users/u/shared"]]))
  })

  test("sandboxCommand builds the sandbox-exec argv and points TMPDIR at the temp root", () => {
    const result = sandboxCommand(policy, { shell: "make test", shellPath: "/bin/zsh", cwd: "/Users/u/project" }, {
      detection: { available: true, backend: "seatbelt", sandboxExecPath: "/usr/bin/sandbox-exec" },
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk" },
    })
    if (result.kind !== "ready") throw new Error("expected ready")
    expect(result.argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"])
    expect(result.argv.slice(3)).toEqual([
      "-DWRITABLE_0=/Users/u/project",
      "-DWRITABLE_1=/Users/u/.cache/session-tmp",
      "-DHIDDEN_0=/Users/u/.ssh",
      "-DHIDDEN_1=/Users/u/Library/Keychains",
      "--",
      "/bin/zsh",
      "-c",
      "make test",
    ])
    expect(result.env).toEqual({ PATH: "/usr/bin", TMPDIR: "/Users/u/.cache/session-tmp" })
  })
})

test("defaultPolicy plans cleanly for both backends", () => {
  const policy = defaultPolicy({ workspace: "/w", home: "/h", env: {}, platform: "darwin" })
  expect(sandboxCommand(policy, { argv: ["true"], cwd: "/w" }, { detection: { available: true, backend: "seatbelt", sandboxExecPath: "/usr/bin/sandbox-exec" }, env: {} }).kind).toBe("ready")
})
