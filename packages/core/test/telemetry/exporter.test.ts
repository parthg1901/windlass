/**
 * The OTLP encoding and the exporters, against a fake collector started in
 * the test (`Bun.serve` on a free port): one that accepts, one that fails and
 * recovers, one that refuses, one that is too slow, and one that reports a
 * partial success. Plus the file exporter and the background queue.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../src/brand.ts"
import { createBackgroundExporter, exportOtlpHttp, tracesUrl, writeOtlpFile } from "../../src/telemetry/exporter.ts"
import { type ExportTraceServiceRequest, SCOPE, batches, encodeSpan, nanos } from "../../src/telemetry/otlp.ts"
import type { Span } from "../../src/telemetry/span.ts"
import { spanIdOf, traceIdOf } from "../../src/telemetry/span.ts"

const scratch = mkdtempSync(join(tmpdir(), "lh-otel-export-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function span(n: number, more: Partial<Span> = {}): Span {
  return {
    traceId: traceIdOf("s", 1),
    spanId: spanIdOf("s", n),
    parentSpanId: n === 0 ? null : spanIdOf("s", 0),
    name: `span ${n}`,
    kind: n === 0 ? "internal" : "client",
    startMs: Date.UTC(2026, 10, 12, 9, 0, 0) + n,
    endMs: Date.UTC(2026, 10, 12, 9, 0, 1) + n,
    open: false,
    sessionId: "s",
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 1200, ratio: 0.5, flag: true, list: ["a", "b"] },
    events: [{ name: "tool.started", timeMs: Date.UTC(2026, 10, 12, 9, 0, 0, 500), attributes: {} }],
    links: [],
    status: { code: n % 2 === 0 ? "ok" : "error", ...(n % 2 === 0 ? {} : { message: "broke" }) },
    ...more,
  }
}
const spans = (count: number) => Array.from({ length: count }, (_, n) => span(n))

/** A fake collector. `respond` decides each answer; every request is recorded. */
function collector(respond: (index: number, request: Request) => Response | Promise<Response>) {
  const received: { readonly headers: Headers; readonly path: string; readonly body: ExportTraceServiceRequest }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const index = received.length
      received.push({ headers: request.headers, path: new URL(request.url).pathname, body: (await request.json()) as ExportTraceServiceRequest })
      return respond(index, request)
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, received }
}
const servers: { stop: (force?: boolean) => unknown }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})
const fast = { backoffMs: 5, maxBackoffMs: 20 }

describe("the OTLP/JSON encoding", () => {
  test("IDs as hex, times as nanosecond strings, integers as strings, enums as numbers, the scope and the service", () => {
    const encoded = encodeSpan(span(1))
    expect(encoded).toMatchObject({
      traceId: traceIdOf("s", 1),
      spanId: spanIdOf("s", 1),
      parentSpanId: spanIdOf("s", 0),
      kind: 3,
      startTimeUnixNano: "1794474000001000000",
      status: { code: 2, message: "broke" },
    })
    expect(encoded.attributes).toEqual([
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: "1200" } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      { key: "flag", value: { boolValue: true } },
      { key: "list", value: { arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } } },
    ])
    expect(encodeSpan(span(0)).parentSpanId).toBeUndefined()
    expect(encodeSpan(span(0)).kind).toBe(1)
    expect(nanos(1)).toBe("1000000")
    const [batch] = batches([span(0)])
    const body = JSON.parse(batch!.body) as ExportTraceServiceRequest
    expect(body.resourceSpans[0]!.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: brand.name } }])
    expect(body.resourceSpans[0]!.scopeSpans[0]!.scope).toEqual(SCOPE)
  })

  test("batches respect the span count and the byte size, in order", () => {
    expect(batches(spans(5), { maxSpans: 2 }).map((batch) => batch.spans)).toEqual([2, 2, 1])
    const one = Math.max(...spans(4).map((item) => JSON.stringify(encodeSpan(item)).length + 1))
    expect(batches(spans(4), { maxBytes: one * 2 }).map((batch) => batch.spans)).toEqual([2, 2])
    // A span larger than the limit still goes, alone.
    expect(batches(spans(2), { maxBytes: 10 }).map((batch) => batch.spans)).toEqual([1, 1])
    expect(batches([])).toEqual([])
  })

  test("the traces URL", () => {
    expect(tracesUrl("http://localhost:4318")).toBe("http://localhost:4318/v1/traces")
    expect(tracesUrl("http://localhost:4318/")).toBe("http://localhost:4318/v1/traces")
    expect(tracesUrl("https://otel.example/v1/traces")).toBe("https://otel.example/v1/traces")
  })
})

describe("the OTLP/HTTP exporter", () => {
  test("posts JSON to /v1/traces with the headers given, batch by batch", async () => {
    const fake = collector(() => new Response("{}", { status: 200 }))
    const result = await exportOtlpHttp(spans(5), { endpoint: fake.url, headers: { authorization: "Bearer test-token-value" }, limits: { maxSpans: 2 } })
    expect(result).toMatchObject({ sent: 5, failed: 0 })
    expect(result.batches.map((batch) => [batch.ok, batch.spans, batch.attempts, batch.status])).toEqual([
      [true, 2, 1, 200],
      [true, 2, 1, 200],
      [true, 1, 1, 200],
    ])
    expect(fake.received.map((request) => request.path)).toEqual(["/v1/traces", "/v1/traces", "/v1/traces"])
    expect(fake.received[0]!.headers.get("authorization")).toBe("Bearer test-token-value")
    expect(fake.received[0]!.headers.get("content-type")).toBe("application/json")
    expect(fake.received.flatMap((request) => request.body.resourceSpans[0]!.scopeSpans[0]!.spans.map((item) => item.name))).toEqual(["span 0", "span 1", "span 2", "span 3", "span 4"])
  })

  test("a collector that fails with a transient error is tried again, with backoff and its Retry-After", async () => {
    const slept: number[] = []
    const fake = collector((index) => (index < 2 ? new Response("busy", { status: index === 0 ? 503 : 429, headers: index === 1 ? { "retry-after": "0.01" } : {} }) : new Response("{}")))
    const result = await exportOtlpHttp(spans(1), { endpoint: fake.url, ...fast, sleep: async (ms) => void slept.push(ms) })
    expect(result.batches[0]).toMatchObject({ ok: true, attempts: 3, status: 200, error: null })
    expect(slept).toEqual([5, 10])
    expect(fake.received).toHaveLength(3)
  })

  test("a collector that keeps failing: bounded retries, then the batch is reported failed; nothing throws", async () => {
    const fake = collector(() => new Response("down", { status: 502 }))
    const result = await exportOtlpHttp(spans(3), { endpoint: fake.url, retries: 2, ...fast })
    expect(result).toMatchObject({ sent: 0, failed: 3 })
    expect(result.batches[0]).toMatchObject({ ok: false, attempts: 3, status: 502, error: "HTTP 502: down" })
    expect(fake.received).toHaveLength(3)
  })

  test("a refusal that is not transient is not retried, and the header values are in no error", async () => {
    const fake = collector(() => new Response("bad request", { status: 400 }))
    const result = await exportOtlpHttp(spans(1), { endpoint: fake.url, headers: { "x-api-key": "secret-header-value" }, ...fast })
    expect(result.batches[0]).toMatchObject({ ok: false, attempts: 1, status: 400 })
    expect(JSON.stringify(result)).not.toContain("secret-header-value")
  })

  test("a slow collector: each attempt times out, is retried a bounded number of times, and the export ends", async () => {
    const fake = collector(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("{}")), 1_000)))
    const started = Date.now()
    const result = await exportOtlpHttp(spans(1), { endpoint: fake.url, timeoutMs: 100, retries: 1, ...fast })
    expect(Date.now() - started).toBeLessThan(900)
    expect(result.batches[0]).toMatchObject({ ok: false, attempts: 2, status: null, error: "no response within 100 ms" })
    expect(result.failed).toBe(1)
  })

  test("no collector at all: a connection error, reported", async () => {
    const fake = collector(() => new Response("{}"))
    servers.splice(0)[0]!.stop(true)
    const result = await exportOtlpHttp(spans(1), { endpoint: fake.url, retries: 1, ...fast })
    expect(result.batches[0]!.ok).toBe(false)
    expect(result.batches[0]!.error).toStartWith("request failed:")
  })

  test("a partial success: the rejected spans are counted as failed", async () => {
    const fake = collector(() => Response.json({ partialSuccess: { rejectedSpans: "2", errorMessage: "2 spans too old" } }))
    const result = await exportOtlpHttp(spans(5), { endpoint: fake.url })
    expect(result).toMatchObject({ sent: 3, failed: 2 })
    expect(result.batches[0]).toMatchObject({ ok: true, rejectedSpans: 2, error: "2 spans too old" })
  })
})

describe("the file exporter", () => {
  test("one OTLP/JSON request body per line; append adds lines", () => {
    const file = join(scratch, "spans", "out.jsonl")
    expect(writeOtlpFile(file, spans(5), { limits: { maxSpans: 2 } })).toBe(3)
    const lines = readFileSync(file, "utf8").trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => (JSON.parse(line) as ExportTraceServiceRequest).resourceSpans[0]!.scopeSpans[0]!.spans.length)).toEqual([2, 2, 1])
    writeOtlpFile(file, spans(1), { append: true })
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(4)
    writeOtlpFile(file, spans(1))
    expect(readFileSync(file, "utf8").trimEnd().split("\n")).toHaveLength(1)
  })
})

describe("the background exporter", () => {
  test("adding never waits or throws; past the queue limit the oldest spans are dropped and counted; a failing sender is counted", async () => {
    const sent: string[][] = []
    let fail = false
    const exporter = createBackgroundExporter(
      async (batch) => {
        if (fail) throw new Error("collector gone")
        sent.push(batch.map((item) => item.name))
        return { batches: [], sent: batch.length, failed: 0 }
      },
      { maxQueue: 3, flushAt: 100 },
    )
    exporter.add(spans(5))
    expect(exporter.stats()).toEqual({ queued: 3, dropped: 2, sent: 0, failed: 0 })
    await exporter.flush()
    expect(sent).toEqual([["span 2", "span 3", "span 4"]])
    fail = true
    exporter.add(spans(2))
    await exporter.flush()
    expect(exporter.stats()).toEqual({ queued: 0, dropped: 2, sent: 3, failed: 2 })
  })

  test("reaching flushAt starts a flush by itself; a flush during a send waits for it", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sizes: number[] = []
    const exporter = createBackgroundExporter(
      async (batch) => {
        sizes.push(batch.length)
        await gate
        return { batches: [], sent: batch.length, failed: 0 }
      },
      { flushAt: 2 },
    )
    exporter.add(spans(2))
    exporter.add(spans(1))
    const flushed = exporter.flush()
    release()
    await flushed
    expect(sizes).toEqual([2, 1])
    expect(exporter.stats()).toMatchObject({ queued: 0, sent: 3 })
  })
})
