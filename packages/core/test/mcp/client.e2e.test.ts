/** The session layer against real scripted servers: era detection, listing with pagination, calls, list changes, both transports. */
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openSession } from "../../src/mcp/client.ts"
import { openHttpChannel } from "../../src/mcp/http.ts"
import { type McpToolDefinition, parseToolDefinition } from "../../src/mcp/protocol.ts"
import { openStdioChannel } from "../../src/mcp/stdio.ts"
import { type HttpFixture, startHttpFixture } from "./fixtures/http-server.ts"
import { STDIO_SERVER, cleanup, never, onCleanup, readLog, tempDir, waitFor } from "./helpers.ts"

afterEach(cleanup)

function stdio(flags: string[] = []) {
  const channel = openStdioChannel({ command: process.execPath, args: [STDIO_SERVER, ...flags], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, graceMs: 500 })
  onCleanup(() => channel.close())
  return channel
}

function http(era: "modern" | "legacy", flags: string[] = []): HttpFixture {
  const fixture = startHttpFixture({ era, flags })
  onCleanup(() => fixture.stop())
  return fixture
}

const timeout = () => AbortSignal.timeout(10_000)
const named = (tools: readonly McpToolDefinition[], name: string) => tools.find((tool) => tool.name === name)!

describe("stdio", () => {
  test("a modern server is detected by server/discover and lists every page", async () => {
    const session = await openSession(stdio(["--filler", "7", "--page-size", "3"]), { signal: timeout(), protocol: "auto", probeMs: 300 })
    expect(session.era).toBe("modern")
    expect(session.protocolVersion).toBe("2026-07-28")
    expect(session.serverInfo).toEqual({ name: "fixture", version: "1.0.0" })
    expect(session.instructions).toBe("Modern fixture fixture.")
    const listing = await session.listTools(timeout())
    // 13 built-in tools and 7 fillers over 7 pages of 3.
    expect(listing.tools.length).toBe(20)
    expect(new Set(listing.tools.map((tool) => tool.name)).size).toBe(20)
    expect(listing.tools.map((tool) => tool.name)).toContain("tool_006")
  })

  test("a legacy server that rejects the probe falls back to initialize", async () => {
    const session = await openSession(stdio(["--era", "legacy"]), { signal: timeout(), protocol: "auto", probeMs: 5000 })
    expect(session.era).toBe("legacy")
    expect(session.protocolVersion).toBe("2025-11-25")
    expect((await session.listTools(timeout())).tools.length).toBe(13)
  })

  test("a legacy server that ignores the probe is reached after probeMs", async () => {
    const started = performance.now()
    const session = await openSession(stdio(["--era", "legacy-silent"]), { signal: timeout(), protocol: "auto", probeMs: 300 })
    expect(session.era).toBe("legacy")
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)
  })

  test("a modern server that starts slower than probeMs is still detected as modern", async () => {
    const session = await openSession(stdio(["--startup-delay", "800"]), { signal: timeout(), protocol: "auto", probeMs: 100 })
    expect(session.era).toBe("modern")
  })

  test("a dual-era server is served as modern", async () => {
    const session = await openSession(stdio(["--era", "dual"]), { signal: timeout(), protocol: "auto", probeMs: 300 })
    expect(session.era).toBe("modern")
  })

  test("the era can be fixed by configuration", async () => {
    const session = await openSession(stdio(["--era", "dual"]), { signal: timeout(), protocol: "legacy" })
    expect(session.era).toBe("legacy")
    await expect(openSession(stdio(["--era", "legacy"]), { signal: timeout(), protocol: "modern" })).rejects.toThrow(/server\/discover/)
  })

  test("calls return text, structured content, images, resources and the error flag", async () => {
    const session = await openSession(stdio(), { signal: timeout(), protocol: "auto", probeMs: 300 })
    const tools = (await session.listTools(timeout())).tools
    expect(await session.callTool(named(tools, "echo"), { text: "hi" }, { signal: never })).toEqual({ content: [{ type: "text", text: "hi" }], structured: undefined, isError: false })
    expect((await session.callTool(named(tools, "add"), { a: 2, b: 3 }, { signal: never })).structured).toEqual({ sum: 5 })
    const image = await session.callTool(named(tools, "image"), {}, { signal: never })
    expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png" })
    expect((await session.callTool(named(tools, "fail"), {}, { signal: never })).isError).toBe(true)
    const resources = await session.callTool(named(tools, "resources"), {}, { signal: never })
    expect(resources.content.map((item) => item.type)).toEqual(["resource_link", "resource", "audio"])
  })

  test("progress notifications reach the caller", async () => {
    const session = await openSession(stdio(), { signal: timeout(), protocol: "auto", probeMs: 300 })
    const tools = (await session.listTools(timeout())).tools
    const progress: string[] = []
    await session.callTool(named(tools, "slow"), { ms: 60 }, { signal: never, onProgress: (text) => progress.push(text) })
    expect(progress).toEqual(["1/3 step 1", "2/3 step 2", "3/3 step 3"])
  })

  test("cancelling a call sends notifications/cancelled for that request", async () => {
    const log = join(tempDir(), "log")
    const session = await openSession(stdio(["--log", log]), { signal: timeout(), protocol: "auto", probeMs: 300 })
    const tools = (await session.listTools(timeout())).tools
    const controller = new AbortController()
    const call = session.callTool(named(tools, "hang"), {}, { signal: controller.signal })
    await waitFor(() => readLog(log).includes("call hang"))
    controller.abort(new Error("the user cancelled"))
    await expect(call).rejects.toMatchObject({ kind: "cancelled" })
    await waitFor(() => readLog(log).some((line) => line.startsWith("cancelled ")), 5000, "the server to see the cancellation")
    // The server is still usable.
    expect((await session.callTool(named(tools, "echo"), { text: "after" }, { signal: never })).content).toEqual([{ type: "text", text: "after" }])
  })

  for (const era of ["modern", "legacy"]) {
    test(`a ${era} server's list change is heard`, async () => {
      const session = await openSession(stdio(["--era", era]), { signal: timeout(), protocol: "auto", probeMs: 300 })
      const tools = (await session.listTools(timeout())).tools
      let changes = 0
      session.watchTools(() => (changes += 1))
      await Bun.sleep(100)
      await session.callTool(named(tools, "add_tool"), { name: "late_tool" }, { signal: never })
      await waitFor(() => changes > 0, 5000, "a list change")
      expect((await session.listTools(timeout())).tools.map((tool) => tool.name)).toContain("late_tool")
    })
  }

  test("tools the harness cannot use are rejected with a reason, the rest are kept", async () => {
    const session = await openSession(stdio(["--bad-tools"]), { signal: timeout(), protocol: "auto", probeMs: 300 })
    const listing = await session.listTools(timeout())
    expect(listing.tools.length).toBe(13)
    expect(listing.rejected.map((entry) => entry.name).sort()).toEqual(["no schema", "noschema"])
  })

  test("garbage on stdout is counted and ignored", async () => {
    const channel = stdio(["--garbage"])
    const session = await openSession(channel, { signal: timeout(), protocol: "auto", probeMs: 300 })
    expect((await session.listTools(timeout())).tools.length).toBe(13)
    expect(channel.diagnostics().garbageLines).toBeGreaterThan(0)
    expect(channel.diagnostics().garbageSamples[0]).toContain("not JSON-RPC")
  })

  test("a server that exits during a call rejects it as closed", async () => {
    const channel = stdio()
    const session = await openSession(channel, { signal: timeout(), protocol: "auto", probeMs: 300 })
    const tools = (await session.listTools(timeout())).tools
    await expect(session.callTool(named(tools, "crash"), {}, { signal: never })).rejects.toMatchObject({ kind: "closed" })
    expect(await session.closed).toBe("the server process exited with code 3")
    expect(channel.diagnostics().stderrTail).toContain("crashing in the middle of a call")
  })

  test("a command that does not exist fails to start", () => {
    expect(() => openStdioChannel({ command: "/nonexistent/mcp-server", args: [], cwd: process.cwd(), env: {} })).toThrow(/could not start/)
  })
})

describe("streamable HTTP", () => {
  test("a modern server: discover, headers, pagination, calls", async () => {
    const fixture = http("modern", ["--filler", "5", "--page-size", "4"])
    const session = await openSession(openHttpChannel({ url: fixture.url, headers: {} }), { signal: timeout(), protocol: "auto" })
    expect(session.era).toBe("modern")
    const tools = (await session.listTools(timeout())).tools
    expect(tools.length).toBe(18)
    expect((await session.callTool(named(tools, "add"), { a: 1, b: 1 }, { signal: never })).structured).toEqual({ sum: 2 })
    // `x-mcp-header` parameters are mirrored into headers; the fixture rejects a mismatch with HeaderMismatch.
    const region = await session.callTool(named(tools, "region"), { region: "eu-west 1 ü" }, { signal: never })
    expect(region.content).toEqual([{ type: "text", text: "region=eu-west 1 ü header==?base64?ZXUtd2VzdCAxIMO8?=" }])
    expect(fixture.events.filter((event) => event.startsWith("header-mismatch"))).toEqual([])
  })

  test("a modern server's progress and cancellation travel on the request's stream", async () => {
    const fixture = http("modern")
    const session = await openSession(openHttpChannel({ url: fixture.url, headers: {} }), { signal: timeout(), protocol: "auto" })
    const tools = (await session.listTools(timeout())).tools
    const progress: string[] = []
    await session.callTool(named(tools, "slow"), { ms: 60 }, { signal: never, onProgress: (text) => progress.push(text) })
    expect(progress.length).toBe(3)
    const controller = new AbortController()
    const call = session.callTool(named(tools, "hang"), {}, { signal: controller.signal })
    await Bun.sleep(150)
    controller.abort(new Error("stop"))
    await expect(call).rejects.toMatchObject({ kind: "cancelled" })
    await waitFor(() => fixture.events.some((event) => event.startsWith("cancelled")), 5000, "the server to see the stream close")
  })

  test("a modern server's list changes arrive on subscriptions/listen", async () => {
    const fixture = http("modern")
    const session = await openSession(openHttpChannel({ url: fixture.url, headers: {} }), { signal: timeout(), protocol: "auto" })
    const tools = (await session.listTools(timeout())).tools
    let changes = 0
    session.watchTools(() => (changes += 1))
    await Bun.sleep(150)
    await session.callTool(named(tools, "add_tool"), { name: "remote_late" }, { signal: never })
    await waitFor(() => changes > 0, 5000, "a list change")
    await session.close()
  })

  test("a legacy server: initialize, the session ID, the GET stream, DELETE on close", async () => {
    const fixture = http("legacy")
    const session = await openSession(openHttpChannel({ url: fixture.url, headers: {} }), { signal: timeout(), protocol: "auto" })
    expect(session.era).toBe("legacy")
    expect(session.protocolVersion).toBe("2025-06-18")
    const tools = (await session.listTools(timeout())).tools
    expect(tools.length).toBe(13)
    let changes = 0
    session.watchTools(() => (changes += 1))
    await Bun.sleep(150)
    await session.callTool(named(tools, "add_tool"), { name: "legacy_late" }, { signal: never })
    await waitFor(() => changes > 0, 5000, "a list change")
    const controller = new AbortController()
    const call = session.callTool(named(tools, "hang"), {}, { signal: controller.signal })
    await Bun.sleep(150)
    controller.abort(new Error("stop"))
    await expect(call).rejects.toMatchObject({ kind: "cancelled" })
    await session.close()
    expect(fixture.events).toContain("session ended")
  })

  test("a server that cannot be reached fails with a transport error", async () => {
    const fixture = http("modern")
    await fixture.stop()
    await expect(openSession(openHttpChannel({ url: fixture.url, headers: {} }), { signal: timeout(), protocol: "auto" })).rejects.toMatchObject({ kind: "transport" })
  })

  test("an invalid x-mcp-header rejects only that tool", () => {
    const schema = (header: string, type = "string") => ({ type: "object", properties: { region: { type, "x-mcp-header": header } } })
    expect(parseToolDefinition({ name: "ok", inputSchema: schema("Region") }, { http: true }).ok).toBe(true)
    expect(parseToolDefinition({ name: "bad", inputSchema: schema("Re gion") }, { http: true })).toMatchObject({ ok: false })
    expect(parseToolDefinition({ name: "number", inputSchema: schema("Region", "number") }, { http: true })).toMatchObject({ ok: false })
    const nested = { type: "object", properties: { list: { type: "array", items: { type: "string", "x-mcp-header": "Item" } } } }
    expect(parseToolDefinition({ name: "nested", inputSchema: nested }, { http: true })).toMatchObject({ ok: false })
    // stdio ignores the annotation.
    expect(parseToolDefinition({ name: "nested", inputSchema: nested }, { http: false }).ok).toBe(true)
  })
})
