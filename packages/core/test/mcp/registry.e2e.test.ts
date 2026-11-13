/** The registry with real child processes: background start, timeouts, cancellation, crashes and restarts, list changes, shutdown. */
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createInterrupt } from "../../src/interrupt.ts"
import { isRunning } from "../tools/helpers.ts"
import { HOST_SCRIPT, cleanup, configOf, fixtureServer, never, readLog, registry, tempDir, waitFor } from "./helpers.ts"
import { E2E_TIMEOUT_MS } from "../../src/testing/wait.ts"

// End-to-end: real processes start here, so each test has a limit sized for a slow runner.
setDefaultTimeout(E2E_TIMEOUT_MS)

afterEach(cleanup)

const call = (r: ReturnType<typeof registry>, server: string, tool: string, args: Record<string, never> | object = {}, signal = never) =>
  r.call({ server, tool, arguments: args as never, signal })

describe("start-up", () => {
  test("start returns at once and a slow server joins the catalogue later", async () => {
    const r = registry(configOf({ fast: fixtureServer(["--only", "echo"]), slow: fixtureServer(["--startup-delay", "700", "--only", "add"]) }))
    const started = performance.now()
    r.start()
    expect(performance.now() - started).toBeLessThan(50)
    expect(r.catalogue()).toBeNull()
    await waitFor(() => r.status().find((s) => s.name === "fast")?.state === "ready")
    expect(r.servers().map((s) => s.name)).toEqual(["fast"])
    expect(r.status().find((s) => s.name === "slow")?.state).toBe("connecting")
    const first = r.catalogue()!.value
    await waitFor(() => r.servers().length === 2, 10_000, "the slow server")
    const second = r.catalogue()!.value
    expect(second).not.toBe(first)
    expect(second).toContain("slow (1 tool):")
  })

  test("a call to a server that is still starting waits for it", async () => {
    const r = registry(configOf({ slow: fixtureServer(["--startup-delay", "600"]) }))
    r.start()
    const outcome = await call(r, "slow", "echo", { text: "waited" })
    expect(outcome).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: "waited" }] } })
  })

  test("a server that fails to start is retried with backoff and never published", async () => {
    const r = registry(configOf({ broken: fixtureServer(["--crash-on-start"]), fine: fixtureServer(["--only", "echo"]) }))
    r.start()
    await r.settled(10_000)
    await waitFor(() => r.status().find((s) => s.name === "broken")?.state === "retrying")
    const broken = r.status().find((s) => s.name === "broken")!
    expect(broken.error).toContain("exited with code 1")
    expect(broken.error).toContain("fatal: the fixture was told to fail at start-up")
    expect(r.servers().map((s) => s.name)).toEqual(["fine"])
    const outcome = await call(r, "broken", "echo", { text: "x" })
    expect(outcome.kind).toBe("refused")
    expect(outcome.kind === "refused" && outcome.message).toMatch(/^The MCP server broken is not running: the server process exited with code 1.*The harness retries in \d+ s\.$/s)
  })

  test("a server that writes only garbage fails its start-up timeout, saying what it wrote", async () => {
    const r = registry(configOf({ noisy: fixtureServer(["--only-garbage"], { startupTimeoutSeconds: 1 }) }))
    r.start()
    await r.settled(10_000)
    const status = r.status()[0]!
    expect(status.error).toContain("did not finish starting within 1 s")
    expect(status.error).toContain("not MCP messages")
    expect(status.error).toContain("fixture server starting")
  })

  test("a missing environment variable fails only that server, naming it", async () => {
    const r = registry(configOf({ needs: fixtureServer([], { env: { TOKEN: "${WINDLASS_TEST_MISSING_TOKEN}" } }) }), { env: { PATH: process.env.PATH } })
    r.start()
    await r.settled(5000)
    expect(r.status()[0]!.error).toBe("the environment variable WINDLASS_TEST_MISSING_TOKEN named in its env is not set")
  })

  test("the server's environment holds the base variables and its own env only", async () => {
    const dir = tempDir()
    const script = join(dir, "env-server.sh")
    // A "server" that dumps its environment to a file and exits: enough to see what it was given.
    await Bun.write(script, `#!/bin/sh\nenv > "${join(dir, "env.txt")}"\n`)
    const r = registry(configOf({ dump: { command: "/bin/sh", args: [script], env: { GREETING: "hello ${WINDLASS_NAME}" } } }), {
      env: { PATH: process.env.PATH, HOME: "/home/test", WINDLASS_NAME: "world", SECRET_TOKEN: "do-not-pass" },
    })
    r.start()
    await waitFor(() => Bun.file(join(dir, "env.txt")).size > 0)
    const env = readFileSync(join(dir, "env.txt"), "utf8")
    expect(env).toContain("GREETING=hello world")
    expect(env).toContain("HOME=/home/test")
    expect(env).not.toContain("SECRET_TOKEN")
    expect(env).not.toContain("WINDLASS_NAME")
  })

  test("allow and deny lists hide tools", async () => {
    const r = registry(configOf({ some: fixtureServer([], { tools: { allow: ["e*", "add"], deny: ["echo"] } }) }))
    r.start()
    await r.settled()
    expect(r.servers()[0]!.tools.map((tool) => tool.name)).toEqual(["add"])
    expect(r.status()[0]!.hiddenTools).toBe(12)
    const outcome = await call(r, "some", "echo", { text: "x" })
    expect(outcome).toEqual({ kind: "refused", message: "The tool some/echo is not allowed by the configuration of the MCP server some." })
  })

  test("a disabled server is never started", async () => {
    const r = registry(configOf({ off: fixtureServer([], { enabled: false }) }))
    r.start()
    await r.settled(1000)
    expect(r.status()[0]!.state).toBe("disabled")
    expect(r.status()[0]!.pid).toBeNull()
  })
})

describe("calls", () => {
  test("a tool that hangs times out and is cancelled on the server", async () => {
    const log = join(tempDir(), "log")
    const r = registry(configOf({ s: fixtureServer(["--log", log], { timeoutSeconds: 1 }) }))
    r.start()
    await r.settled()
    const started = performance.now()
    const outcome = await call(r, "s", "hang")
    expect(performance.now() - started).toBeGreaterThan(900)
    expect(outcome).toMatchObject({ kind: "failed", serverText: false })
    expect(outcome.kind === "failed" && outcome.message).toBe(
      "The call to s/hang timed out after 1 s and was cancelled. It may or may not have taken effect; check before calling it again.",
    )
    await waitFor(() => readLog(log).some((line) => line.startsWith("cancelled")), 10_000, "the cancellation")
    expect(await call(r, "s", "echo", { text: "still alive" })).toMatchObject({ kind: "result" })
  })

  test("an interrupt cancels the call", async () => {
    const log = join(tempDir(), "log")
    const r = registry(configOf({ s: fixtureServer(["--log", log]) }))
    r.start()
    await r.settled()
    const interrupt = createInterrupt()
    const pending = call(r, "s", "hang", {}, interrupt.signal)
    await waitFor(() => readLog(log).includes("call hang"))
    interrupt.interrupt("user")
    const outcome = await pending
    expect(outcome.kind === "failed" && outcome.message).toStartWith("Interrupted: the call to s/hang was cancelled.")
    await waitFor(() => readLog(log).some((line) => line.startsWith("cancelled")), 10_000, "the cancellation")
  })

  test("a server that crashes mid-call is restarted and the next call works", async () => {
    const r = registry(configOf({ s: fixtureServer() }))
    r.start()
    await r.settled()
    const firstPid = r.status()[0]!.pid!
    const outcome = await call(r, "s", "crash")
    expect(outcome.kind).toBe("failed")
    expect(outcome.kind === "failed" && outcome.message).toBe(
      "The MCP server s stopped during the call to s/crash (the server process exited with code 3). It is restarted automatically. The call may or may not have taken effect; check before calling it again.",
    )
    // The catalogue does not flap: the server is back before the drop delay.
    const catalogue = r.catalogue()
    expect(catalogue).not.toBeNull()
    await waitFor(() => r.status()[0]!.state === "ready" && ![null, firstPid].includes(r.status()[0]!.pid), 10_000, "the restart")
    expect(isRunning(firstPid)).toBe(false)
    expect(await call(r, "s", "echo", { text: "back" })).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: "back" }] } })
    expect(r.catalogue()).toEqual(catalogue)
  })

  test("a server that stays down is withdrawn from the catalogue after the drop delay", async () => {
    const dir = tempDir()
    const r = registry(configOf({ s: fixtureServer(["--pid-file", join(dir, "pid")]) }), { backoff: { initialMs: 5000, maxMs: 5000 } })
    r.start()
    await r.settled()
    let changes = 0
    r.onChange(() => (changes += 1))
    process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL")
    await waitFor(() => r.status()[0]!.state === "retrying")
    expect(r.catalogue()).not.toBeNull()
    await waitFor(() => r.catalogue() === null, 10_000, "the drop")
    expect(changes).toBe(1)
  })

  test("a changed tool list updates the catalogue and the new tool can be called", async () => {
    const r = registry(configOf({ s: fixtureServer(["--only", "add_tool,remove_tool,echo"]) }))
    r.start()
    await r.settled()
    const before = r.catalogue()!.value
    let changes = 0
    r.onChange(() => (changes += 1))
    await call(r, "s", "add_tool", { name: "zeta" })
    await waitFor(() => r.catalogue()!.value.includes("zeta"), 10_000, "the new tool")
    expect(changes).toBeGreaterThan(0)
    expect(await call(r, "s", "zeta")).toMatchObject({ kind: "result", result: { content: [{ type: "text", text: "zeta ran" }] } })
    await call(r, "s", "remove_tool", { name: "zeta" })
    await waitFor(() => !r.catalogue()!.value.includes("zeta"), 10_000, "the removal")
    expect(r.catalogue()!.value).toBe(before)
  })

  test("arguments are checked against the tool's schema before they are sent", async () => {
    const log = join(tempDir(), "log")
    const r = registry(configOf({ gh: fixtureServer(["--log", log]) }))
    r.start()
    await r.settled()
    const outcome = await call(r, "gh", "create_issue", { repo: "not a repo", labels: ["a", 2], titel: "x" })
    expect(outcome.kind).toBe("refused")
    const message = outcome.kind === "refused" ? outcome.message : ""
    expect(message).toStartWith("Invalid arguments for gh/create_issue (not sent):\n")
    expect(message).toContain("- arguments.title: is required")
    expect(message).toContain("- arguments.repo: must match the pattern")
    expect(message).toContain("- arguments.labels[1]: must be a string, got number 2")
    expect(message).toContain('- arguments.titel: is not a known parameter (did you mean "title"?)')
    expect(message).toContain('Its input schema: {"additionalProperties":false,')
    expect(readLog(log)).not.toContain("call create_issue")
  })

  test("unknown servers and tools get close matches", async () => {
    const r = registry(configOf({ github: fixtureServer(), other: fixtureServer(["--only", "echo"]) }))
    r.start()
    await r.settled()
    expect(await call(r, "githb", "echo")).toEqual({
      kind: "refused",
      message: 'There is no MCP server named "githb". Did you mean "github"? Servers: github, other.',
    })
    expect(await call(r, "other", "ech")).toEqual({
      kind: "refused",
      message: 'The MCP server other has no tool named "ech". Close matches on other: echo. Use mcp_search to find tools.',
    })
    expect(await call(r, "other", "add")).toEqual({
      kind: "refused",
      message: 'The MCP server other has no tool named "add". A tool with that name is on github. Use mcp_search to find tools.',
    })
  })

  test("a server's own error comes back as server text", async () => {
    const r = registry(configOf({ s: fixtureServer() }))
    r.start()
    await r.settled()
    // The fixture lists `tool_*` only with --filler, but answers any of them; an unknown name gets its JSON-RPC error.
    const outcome = await call(r, "s", "fail")
    expect(outcome).toMatchObject({ kind: "result", result: { isError: true } })
  })
})

describe("shutdown", () => {
  test("stop leaves no process behind, grandchildren included", async () => {
    const dir = tempDir()
    const r = registry(
      configOf({
        a: fixtureServer(["--pid-file", join(dir, "a"), "--grandchild", join(dir, "a-child")]),
        b: fixtureServer(["--pid-file", join(dir, "b"), "--stubborn"]),
      }),
    )
    r.start()
    await r.settled()
    const pids = ["a", "a-child", "b"].map((name) => Number(readFileSync(join(dir, name), "utf8")))
    expect(pids.every(isRunning)).toBe(true)
    await r.stop()
    await waitFor(() => pids.every((pid) => !isRunning(pid)), 10_000, "every process to exit")
    expect(r.status().map((s) => s.state)).toEqual(["stopped", "stopped"])
    expect(await call(r, "a", "echo", { text: "x" })).toEqual({ kind: "refused", message: "The MCP servers have been shut down." })
  })

  test("stop during start-up abandons it and leaves no process", async () => {
    const dir = tempDir()
    const r = registry(configOf({ slow: fixtureServer(["--pid-file", join(dir, "pid"), "--startup-delay", "5000"]) }))
    r.start()
    await waitFor(() => Bun.file(join(dir, "pid")).size > 0)
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"))
    await r.stop()
    await waitFor(() => !isRunning(pid), 10_000, "the server to exit")
  })

  test("a harness that dies without shutting down takes its servers with it", async () => {
    const dir = tempDir()
    const host = Bun.spawn([process.execPath, HOST_SCRIPT, join(dir, "server"), join(dir, "child")], { stdout: "pipe", stderr: "inherit" })
    const reader = host.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("ready")
    const pids = ["server", "child"].map((name) => Number(readFileSync(join(dir, name), "utf8")))
    expect(pids.every(isRunning)).toBe(true)
    host.kill("SIGKILL")
    await host.exited
    await waitFor(() => pids.every((pid) => !isRunning(pid)), 10_000, "the guard to kill the server group")
  })
})
