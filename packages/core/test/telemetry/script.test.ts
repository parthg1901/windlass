/**
 * `scripts/export-otel.ts` on a session the real CLI wrote with the scripted
 * model (`LH_ACP_SCRIPT`) in a throwaway data directory: to a file, to a
 * fake collector, and read-only (the session's file is not changed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { brand } from "../../src/brand.ts"
import type { ExportTraceServiceRequest, OtlpSpan } from "../../src/telemetry/otlp.ts"

const REPO = resolve(import.meta.dir, "../../../..")
const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-otel-script-")))
const xdg = join(root, "xdg")
const dataDir = join(xdg, brand.directory)
const work = join(root, "work")
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** Runs a command to its end with a time limit; the child is killed by its PID if it overruns. */
async function run(argv: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { cwd: REPO, env: { ...process.env, XDG_DATA_HOME: xdg, NO_COLOR: "1", ...env }, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  return { stdout, stderr, code }
}
const exporter = (...args: string[]) => run(["bun", "scripts/export-otel.ts", ...args, "--data-dir", dataDir])
const spansOf = (lines: string): OtlpSpan[] =>
  lines
    .trim()
    .split("\n")
    .flatMap((line) => (JSON.parse(line) as ExportTraceServiceRequest).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)))
const value = (span: OtlpSpan, key: string) => {
  const found = span.attributes.find((item) => item.key === key)?.value
  return found === undefined ? undefined : Object.values(found)[0]
}

let sessionId = ""
let model = ""
beforeAll(async () => {
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, "a.ts"), "export const a = 1\n")
  const script = join(root, "script.json")
  writeFileSync(
    script,
    JSON.stringify({
      responses: [
        [
          { type: "tool_call", callId: "call_1", name: "read", input: { path: "a.ts" } },
          { type: "usage", inputTokens: 1200, cachedInputTokens: 0, outputTokens: 20 },
        ],
        [
          { type: "text", text: "a is 1." },
          { type: "usage", inputTokens: 1300, cachedInputTokens: 1100, outputTokens: 10 },
        ],
      ],
    }),
  )
  const cli = await run(["bun", "packages/cli/src/main.ts", "--json", "--cwd", work, "--", "What is a?"], { LH_ACP_SCRIPT: script })
  expect(cli.code).toBe(0)
  const created = JSON.parse(cli.stdout.split("\n")[0]!) as { sessionId: string; data: { settings: { model: string } } }
  sessionId = created.sessionId
  model = created.data.settings.model
}, 90_000)

describe("scripts/export-otel.ts", () => {
  test("writes OTLP/JSON to a file: the execution, both model calls and the tool call, in one trace, without content; the session's file is not changed", async () => {
    const database = join(dataDir, "sessions", `${sessionId}.db`)
    const before = readFileSync(database)
    const out = join(root, "spans.jsonl")
    const result = await exporter(sessionId.slice(0, 10), "-o", out)
    expect(result.code).toBe(0)
    expect(result.stderr).toContain(`${sessionId}: 4 spans in 1 trace(s) from 1 session(s)`)
    const spans = spansOf(readFileSync(out, "utf8"))
    expect(spans.map((span) => span.name).toSorted()).toEqual([`invoke_agent ${brand.name}`, `chat ${model}`, `chat ${model}`, "execute_tool read"].toSorted())
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1)
    const root_ = spans.find((span) => span.parentSpanId === undefined)!
    expect(value(root_, "gen_ai.usage.input_tokens")).toBe("2500")
    expect(value(root_, "gen_ai.usage.cache_read.input_tokens")).toBe("1100")
    expect(readFileSync(out, "utf8")).not.toContain("What is a?")
    expect(readFileSync(out, "utf8")).not.toContain("a is 1.")
    expect(readFileSync(database)).toEqual(before)
    // The same session exported again: the same bytes.
    const again = join(root, "again.jsonl")
    await exporter(sessionId, "-o", again)
    expect(readFileSync(again, "utf8")).toBe(readFileSync(out, "utf8"))
  }, 60_000)

  test("--content adds the prompt, the answer, the tool's arguments and output", async () => {
    const result = await exporter(sessionId, "--content")
    expect(result.code).toBe(0)
    const tool = spansOf(result.stdout).find((span) => span.name === "execute_tool read")!
    expect(value(tool, "gen_ai.tool.call.arguments")).toBe('{"path":"a.ts"}')
    expect(String(value(tool, "gen_ai.tool.call.result"))).toContain("export const a = 1")
    expect(result.stdout).toContain("What is a?")
  }, 60_000)

  test("--endpoint posts to a collector with the headers, `${VAR}` read from the environment; a failing collector exits 4", async () => {
    const received: { auth: string | null; spans: number }[] = []
    let status = 200
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as ExportTraceServiceRequest
        received.push({ auth: request.headers.get("authorization"), spans: body.resourceSpans[0]!.scopeSpans[0]!.spans.length })
        return new Response("{}", { status })
      },
    })
    try {
      const ok = await run(["bun", "scripts/export-otel.ts", sessionId, "--endpoint", `http://127.0.0.1:${server.port}`, "--header", "authorization=Bearer ${COLLECTOR_TOKEN}", "--data-dir", dataDir], { COLLECTOR_TOKEN: "tok-123" })
      expect(ok.code).toBe(0)
      expect(received).toEqual([{ auth: "Bearer tok-123", spans: 4 }])
      expect(ok.stderr).not.toContain("tok-123")
      status = 400
      const failed = await run(["bun", "scripts/export-otel.ts", sessionId, "--endpoint", `http://127.0.0.1:${server.port}`, "--data-dir", dataDir])
      expect(failed.code).toBe(4)
      expect(failed.stderr).toContain("0 sent, 4 failed")
    } finally {
      server.stop(true)
    }
  }, 60_000)

  test("usage errors and an unknown session exit 1, and nothing is left in the temporary directory", async () => {
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`${brand.directory}-otel-`)).length
    const before = leftovers()
    expect((await exporter("ses_nope", "-o", join(root, "x.jsonl"))).code).toBe(1)
    expect((await exporter()).code).toBe(1)
    expect((await exporter(sessionId, "-o", "a", "--endpoint", "http://x")).code).toBe(1)
    expect(leftovers()).toBeLessThanOrEqual(before)
  }, 60_000)
})
