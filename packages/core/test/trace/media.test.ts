/**
 * Images and files in an exported trace (prefixlens SPEC.md 4.5, "Binary
 * data", format 1.2): written as their SHA-256 and size, never as their
 * bytes, with the block hash still that of the content as sent, so the
 * trace verifies against the ledger and agrees with prefixlens's recorder.
 *
 * The session is made by the real engine with the scripted model: a tool
 * reads a PNG from the workspace, and the image goes back to the model as an
 * attachment of the tool result.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { deflateSync } from "node:zlib"
import { blobRefs, encodeRequest } from "../../src/provider/openai-responses-encode.ts"
import { hashRequest } from "../../src/request/prefix.ts"
import { script } from "../../src/testing/fake-provider.ts"
import { describeUnverified, exportSession } from "../../src/trace/export.ts"
import { TRACE_FORMAT_VERSION, elideBinary, serializeTrace, traceHash } from "../../src/trace/format.ts"
import { SETTINGS, USAGE, call, closeHarnesses, place, removePlaces, start } from "../engine/assembly-helpers.ts"
import { PREFIXLENS_DIR, loadPrefixlens, report, withPrefixlens } from "./prefixlens.ts"
import { validateTrace } from "./spec.ts"

afterEach(closeHarnesses)
afterAll(removePlaces)

const prefixlens = await loadPrefixlens()

/** A real, decodable PNG: `width` x `height` pixels of one RGB colour. */
function png(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (data: Uint8Array) => {
    let c = 0xffffffff
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, width)
  new DataView(header.buffer).setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8)
  const rows = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(rgb, y * (1 + width * 3) + 1 + x * 3)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", new Uint8Array())]
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  parts.reduce((offset, part) => (out.set(part, offset), offset + part.length), 0)
  return out
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

describe("elideBinary", () => {
  const base64 = Buffer.from(png(2, 2, [255, 0, 0])).toString("base64")
  const image = { type: "input_image", image_url: `data:image/png;base64,${base64}`, detail: "auto" }
  const output = { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "shot.png" }, image] }

  test("writes a data: URL image as its media type, decoded size and the SHA-256 of the base64 text", () => {
    const { content, elided } = elideBinary(output)
    expect(elided).toBe(true)
    const size = Buffer.from(base64, "base64").length
    expect(content).toEqual({ ...output, output: [output.output[0]!, { ...image, image_url: `<binary image/png, ${size} bytes, sha256 ${sha(base64)}>` }] })
  })

  test("keeps a URL that is not a data: URL, and leaves content without binary data as it is", () => {
    const linked = { type: "input_image", image_url: "https://example.test/shot.png" }
    expect(elideBinary(linked)).toEqual({ content: linked, elided: false })
    const text = { type: "message", role: "user", content: [{ type: "input_text", text: "data:image/png;base64,AAAA" }] }
    expect(elideBinary(text)).toEqual({ content: text, elided: false })
  })

  test("a file part is elided too, with or without a data: URL", () => {
    const pdf = { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERi0=" }
    expect(elideBinary(pdf).content).toEqual({ ...pdf, file_data: `<binary application/pdf, 5 bytes, sha256 ${sha("JVBERi0=")}>` })
    expect(elideBinary({ type: "input_file", file_data: "JVBERi0=" }).content).toEqual({ type: "input_file", file_data: `<binary, 5 bytes, sha256 ${sha("JVBERi0=")}>` })
  })

  test.skipIf(prefixlens === null)(withPrefixlens("gives what prefixlens's recorder gives for every part shape SPEC 4.5 names"), async () => {
    const canonical = (await import(`${PREFIXLENS_DIR}/src/canonical.ts`)) as {
      elideBinary: (block: { kind: string; hash: string; content?: unknown }) => { content?: unknown; elided?: boolean }
    }
    const parts = [
      output,
      { type: "input_file", file_data: "JVBERi0=" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
      { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
      { type: "file", file: { file_data: "JVBERi0=" } },
      { inlineData: { mimeType: "image/png", data: base64 } },
      { type: "input_image", image_url: "https://example.test/shot.png" },
    ]
    for (const part of parts) {
      const theirs = canonical.elideBinary({ kind: "message", hash: traceHash(part), content: part })
      const ours = elideBinary(part as never)
      expect(ours.content).toEqual(theirs.content as never)
      expect(ours.elided).toBe(theirs.elided === true)
    }
  })
})

describe(`a session in which a tool reads an image, exported as format ${TRACE_FORMAT_VERSION}`, () => {
  const picture = png(4, 3, [12, 34, 56])
  const base64 = Buffer.from(picture).toString("base64")
  const marker = `<binary image/png, ${picture.length} bytes, sha256 ${sha(base64)}>`

  async function session() {
    const { data, workspace } = place("wl-trace-media-")
    const cwd = workspace("w", {})
    await Bun.write(`${cwd}/shot.png`, picture)
    const { harness, provider } = start(data, [
      // Each call reads from the cache what the call before it sent.
      [call("read", { path: "shot.png" }), USAGE(1100)],
      [script.text("A dark blue rectangle."), script.usage({ inputTokens: 1500, cachedInputTokens: 1024, outputTokens: 10, reasoningTokens: 0 })],
      [script.text("Still blue."), script.usage({ inputTokens: 1550, cachedInputTokens: 1408, outputTokens: 10, reasoningTokens: 0 })],
    ])
    const live = harness.engine.createSession({ cwd, settings: SETTINGS })
    live.send("What is in shot.png?")
    await live.settled()
    live.send("And now?")
    await live.settled()
    const result = harness.sessions.read(live.id, (store) => {
      const exported = exportSession(store, live.id)
      // What went over the wire for each call, encoded as the provider encodes it: what a recording proxy would have seen.
      const sent = provider.requests.map((request) => {
        const blobs = new Map(blobRefs(request).map((ref) => [ref.hash, store.getBlob(ref.hash)!.bytes] as const))
        return { request, body: JSON.parse(encodeRequest(request, blobs).body) as Record<string, unknown> }
      })
      return { exported, sent, rows: store.readRequests(live.id) }
    })
    return { ...result, id: live.id, root: data }
  }

  test("every call is full-request, verified against the ledger, and the image is a hash and a size", async () => {
    const { exported, sent, rows } = await session()
    expect(describeUnverified(exported)).toEqual([])
    expect(exported.records).toHaveLength(3)
    // The ledger stores the hashes of what the provider was given.
    expect(rows.map((row) => row.blocks)).toEqual(sent.map((entry) => hashRequest(entry.request)) as never)
    for (const record of exported.records) expect(record.fidelity).toBe("full-request")

    // The tool result went out with the image in it, as a data: URL.
    const wire = sent[1]!.body.input as { type: string; output?: unknown }[]
    expect(JSON.stringify(wire.find((item) => item.type === "function_call_output"))).toContain(`data:image/png;base64,${base64}`)

    for (const record of exported.records.slice(1)) {
      const results = record.request!.blocks.filter((block) => block.key === "function_call_output")
      expect(results).toHaveLength(1)
      const result = results[0]!
      expect(result.elided).toBe(true)
      expect(JSON.stringify(result.content)).toContain(marker)
      // The hash is over the block as sent, image bytes included.
      const asSent = wire.find((item) => item.type === "function_call_output")
      expect(result.hash).toBe(traceHash(asSent))
      expect(result.hash).not.toBe(traceHash(result.content))
    }
    // No other block was touched.
    for (const record of exported.records)
      for (const block of record.request!.blocks) if (block.key !== "function_call_output") expect(block.elided).toBeUndefined()

    const trace = serializeTrace(exported.records)
    expect(trace).not.toContain(base64)
    expect(trace).not.toContain(base64.slice(0, 24))
    expect(trace).not.toContain("data:image")
    expect(validateTrace(trace).errors).toEqual([])
  }, 60_000)

  test.skipIf(prefixlens === null)(withPrefixlens("the records agree block for block with prefixlens's recorder, and prefixlens reads and reports the trace"), async () => {
    const { exported, sent, rows, id, root } = await session()
    exported.records.forEach((record, index) => {
      const row = rows[index]!
      const proxied = prefixlens!.recorder.buildRecord({
        api: "openai-responses",
        body: sent[index]!.body,
        response: {
          usage: {
            input_tokens: row.usage!.inputTokens,
            input_tokens_details: { cached_tokens: row.usage!.cachedInputTokens },
            output_tokens: row.usage!.outputTokens,
            output_tokens_details: { reasoning_tokens: row.usage!.reasoningTokens },
          },
          complete: true,
        },
        startedAt: new Date(row.startedAt),
        lane: "main",
        recorder: "proxy",
      })
      if (typeof proxied === "string") throw new Error(proxied)
      expect(record.request!.blocks).toEqual((proxied.request as { blocks: never }).blocks)
      for (const field of ["usage", "interrupted", "billing"]) expect((record as unknown as Record<string, unknown>)[field]).toEqual(proxied[field])
    })

    const trace = serializeTrace(exported.records)
    const parsed = prefixlens!.reader.parseTrace(trace)
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    const file = `${root}/trace.jsonl`
    await Bun.write(file, trace)
    const { json } = report(prefixlens!.cli, file)
    expect(json.summary.fidelity).toEqual({ full_request: 3, usage_only: 0 })
    expect(json.summary.misses).toBe(0)
    expect(id).toBeTruthy()
  }, 60_000)

  test("the export command reads the image from the data directory's blob store and writes it as a hash and a size", async () => {
    const { id, root } = await session()
    const out = `${root}/command.jsonl`
    const run = Bun.spawnSync(["bun", `${import.meta.dir}/../../../../scripts/export-trace.ts`, id, "--data-dir", root, "-o", out], { stdout: "pipe", stderr: "pipe" })
    expect(run.stderr.toString()).toContain("3 exported (3 full-request, 0 usage-only)")
    expect(run.exitCode).toBe(0)
    const trace = await Bun.file(out).text()
    expect(trace).toContain(marker)
    expect(trace).not.toContain(base64.slice(0, 24))
    expect(validateTrace(trace).errors).toEqual([])
  }, 60_000)

  test.skipIf(prefixlens === null)(withPrefixlens("a 1.1 trace, with the image written in full, still reads the same in prefixlens"), async () => {
    const { exported, root } = await session()
    // What the exporter wrote before format 1.2: the same blocks with the content as sent.
    const old = exported.records.map((record) => ({
      ...record,
      request: {
        blocks: record.request!.blocks.map((block) => {
          if (!block.elided) return block
          const { elided: _, ...rest } = block
          const asSent = JSON.parse(JSON.stringify(rest.content).replace(marker, `data:image/png;base64,${base64}`))
          expect(traceHash(asSent)).toBe(block.hash)
          return { ...rest, content: asSent }
        }),
      },
    }))
    const parsed = prefixlens!.reader.parseTrace(serializeTrace(old as never))
    expect(parsed.errors).toEqual([])
    expect(parsed.warnings).toEqual([])
    const [oldFile, newFile] = [`${root}/old.jsonl`, `${root}/new.jsonl`]
    await Bun.write(oldFile, serializeTrace(old as never))
    await Bun.write(newFile, serializeTrace(exported.records))
    const summary = (file: string) => {
      const { json } = report(prefixlens!.cli, file)
      return { fidelity: json.summary.fidelity, misses: json.summary.misses, statuses: json.turns.map((turn) => [turn.status, turn.hit_rate]) }
    }
    expect(summary(oldFile)).toEqual(summary(newFile))
  }, 60_000)
})
