import { describe, expect, test } from "bun:test"
import { type Grant, type HistoryEntry, decide, deriveTaint, escalationFacts, escalationRequest, sandboxHint, stampGrants } from "../../src/approval/index.ts"
import { brand } from "../../src/brand.ts"
import { safeDecode } from "../../src/validate.ts"
import { HOME, NOW, WS, call, input } from "./fixtures.ts"

function safeDecodeEscalation(value: unknown) {
  const result = safeDecode((input, path) => escalationRequest(input, path === "" ? "sandbox" : path), value)
  return result.ok ? "ok" : result.error.message
}

describe("escalationRequest", () => {
  test("absent or empty is no escalation", () => {
    expect(escalationRequest(undefined, "sandbox")).toBeNull()
    expect(escalationRequest({}, "sandbox")).toBeNull()
    expect(escalationRequest({ network: false, write: [] }, "sandbox")).toBeNull()
  })

  test("network and deduplicated write paths", () => {
    expect(escalationRequest({ network: true }, "sandbox")).toEqual({ network: true, write: [] })
    expect(escalationRequest({ write: ["/a", "/a", "/b"] }, "sandbox")).toEqual({ network: false, write: ["/a", "/b"] })
  })

  test("rejects unknown keys, wrong types and too many paths", () => {
    expect(safeDecodeEscalation({ hosts: ["x"] })).toContain("sandbox.hosts")
    expect(safeDecodeEscalation({ network: "yes" })).toContain("sandbox.network")
    expect(safeDecodeEscalation({ write: Array.from({ length: 9 }, (_, i) => `/p${i}`) })).toContain("at most 8")
    expect(safeDecodeEscalation({ write: [""] })).toContain("sandbox.write[0]")
  })
})

describe("sandboxHint", () => {
  const run = (output: string, overrides: Partial<Parameters<typeof sandboxHint>[0]> = {}) =>
    sandboxHint({ sandboxed: true, network: false, exitCode: 1, output, ...overrides })

  test("what curl and bun print when the sandbox has no network, a server on this machine included, is recognised", () => {
    // Seen with real processes under bubblewrap with the network off: loopback is down, so a local server is unreachable too.
    for (const output of [
      "curl: (7) Failed to connect to 127.0.0.1 port 37749 after 0 ms: Couldn't connect to server",
      "curl: (6) Could not resolve host: example.com",
      "error: DNSResolveFailed downloading package manifest typescript",
      "error: ConnectionRefused downloading tarball left-pad@1.3.0",
    ])
      expect(run(output)?.suspects, output).toEqual(["network"])
  })

  test("suspects writes on EROFS and EACCES, the network on DNS and connection errors", () => {
    expect(run("touch: cannot touch '/opt/x': Read-only file system")?.suspects).toEqual(["write"])
    expect(run("curl: (6) Could not resolve host: example.org")?.suspects).toEqual(["network"])
    expect(run("npm ERR! code EAI_AGAIN\nnpm ERR! EACCES: permission denied, mkdir '/usr/lib/node_modules'")?.suspects).toEqual(["network", "write"])
  })

  test("names the argument to retry with", () => {
    expect(run("getaddrinfo ENOTFOUND registry.npmjs.org")?.note).toBe(
      '[sandbox] This command ran in the sandbox (no network, and writes only inside the workspace and the temp directory), and its output shows an error the sandbox can cause. If it needs that access, run it again with `sandbox: { "network": true }`; the user will be asked.',
    )
  })

  test("says nothing for a success, a stopped command, an unsandboxed one, or an unrelated failure", () => {
    expect(run("Read-only file system", { exitCode: 0 })).toBeNull()
    expect(run("Read-only file system", { exitCode: null })).toBeNull()
    expect(run("Read-only file system", { sandboxed: false })).toBeNull()
    expect(run("1 test failed: expected 2, got 3")).toBeNull()
    expect(run("Connection refused", { network: true })).toBeNull()
  })

  test("a refused change to the git configuration, hooks or project directory is named as such, not as a write to ask for", () => {
    for (const output of [
      "error: could not write config file .git/config: Device or resource busy",
      "error: could not write config file /work/.git/config: Device or resource busy\nfatal: could not set 'remote.origin.url' to 'https://example.com/r.git'",
      "touch: cannot touch '.git/hooks/pre-commit': Read-only file system",
      `mkdir: cannot create directory '.${brand.directory}/x': Read-only file system`,
    ]) {
      const hint = run(output, { exitCode: 4 })
      expect(hint?.suspects, output).toEqual(["git"])
      expect(hint?.note).toContain("no `sandbox` argument changes that")
    }
    // Another refused write in the same output is still one to ask for.
    expect(run("touch: cannot touch '.git/hooks/x': Read-only file system\ntouch: cannot touch '/opt/y': Read-only file system")?.suspects).toEqual(["write", "git"])
    expect(run("error: could not write config file .git/config: Device or resource busy", { exitCode: 0 })).toBeNull()
  })

  test("a command that exited 0 gets the network note only for a failed lookup as a client reports it", () => {
    for (const output of [
      "curl: (6) Could not resolve host: example.com",
      "fatal: unable to access 'https://example.com/r.git/': Could not resolve host: example.com",
      "npm error request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org",
      "TypeError: getaddrinfo ETIMEOUT example.com",
      "urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>",
      "Resolving example.com (example.com)... failed: Temporary failure in name resolution.",
      "wget: unable to resolve host address \u2018example.com\u2019",
      "ping: example.com: Temporary failure in name resolution",
      "ssh: Could not resolve hostname example.com: Temporary failure in name resolution",
      "error: DNSResolveFailed downloading package manifest typescript",
    ]) {
      const hint = run(output, { exitCode: 0 })
      expect(hint?.suspects, output).toEqual(["network"])
      expect(hint?.note).toContain("although it exited 0")
    }
    for (const output of [
      'if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") retry()',
      "throw new Error(`Could not resolve host: ${host}`)",
      "throw new Error('Could not resolve host: ' + host)",
      "// getaddrinfo EAI_AGAIN means the DNS lookup timed out",
      'log("Temporary failure in name resolution")',
      "DNS lookup ok",
      "curl: (7) Failed to connect to 127.0.0.1 port 3000 after 0 ms: Couldn't connect to server",
      "Error: connect ECONNREFUSED 127.0.0.1:5432",
    ])
      expect(run(output, { exitCode: 0 }), output).toBeNull()
    expect(run("curl: (6) Could not resolve host: example.com", { exitCode: 0, network: true })).toBeNull()
  })
})

describe("the escalation flow", () => {
  const paths = { cwd: WS, workspace: WS, home: HOME, hiddenPaths: [`${HOME}/.ssh`], readlink: () => null }

  test("fails in the sandbox, model asks for network, user allows it for the session, later taint asks again", () => {
    // 1. A plain command runs sandboxed without asking.
    const first = decide(input({ call: call({ tool: "shell", effect: "exec", command: "npm install" }) }))
    expect(first).toEqual({ kind: "run_sandboxed", network: false, writableRoots: [] })

    // 2. It fails; the hint tells the model how to ask.
    const hint = sandboxHint({ sandboxed: true, network: false, exitCode: 1, output: "npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org" })
    expect(hint?.note).toContain('sandbox: { "network": true }')

    // 3. The model retries with the explicit argument; the user is asked.
    const request = escalationRequest({ network: true }, "sandbox")!
    const retry = call({ tool: "shell", effect: "exec", command: "npm install", escalation: escalationFacts(request, paths) })
    const asked = decide(input({ call: retry }))
    if (asked.kind !== "ask") throw new Error("expected ask")
    expect(asked.question.title).toBe("Allow network access for this command?")

    // 4. "Allow for this session" at seq 20 stores exactly what it said.
    const session = asked.question.choices.find((choice) => choice.id === "session")!
    const grants: Grant[] = stampGrants(session.grants, 20, NOW)
    expect(grants).toEqual([{ scope: "session", rule: { kind: "sandbox-network" }, at: 20, grantedAt: NOW }])

    // 5. The next escalated command runs without asking; one without the argument still has no network.
    expect(decide(input({ call: retry, grants }))).toEqual({ kind: "run_sandboxed", network: true, writableRoots: [] })
    expect(decide(input({ call: call({ tool: "shell", effect: "exec", command: "ls" }), grants }))).toEqual({ kind: "run_sandboxed", network: false, writableRoots: [] })

    // 6. That command's output came from the network: the session is tainted from seq 21, and the grant from 20 no longer applies.
    const history: HistoryEntry[] = [{ kind: "tool_result", at: 21, tool: "shell", effect: "exec", origin: "builtin", paths: [], networkGranted: true }]
    const taint = deriveTaint(history, { untrustedPaths: [] })
    expect(taint).toMatchObject({ tainted: true, since: 21 })
    expect(decide(input({ call: retry, grants, taint })).kind).toBe("ask")

    // 7. Unattended, the same call is refused, never left waiting.
    expect(decide(input({ call: retry, grants, taint, present: false })).kind).toBe("deny")
  })
})
