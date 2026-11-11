import { readdirSync } from "node:fs"
import { join } from "node:path"
import { ResponsesStreamMapper } from "../../src/provider/openai-responses-decode.ts"
import type { StreamEvent } from "../../src/provider/provider.ts"
import { SseParser } from "../../src/provider/sse.ts"

export const FIXTURES = join(import.meta.dir, "..", "fixtures", "responses")

/** Every SSE fixture, real and synthetic, by file name. */
export const sseFixtures = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".sse"))
  .sort()

export async function fixtureBytes(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(join(FIXTURES, name)).arrayBuffer())
}

/** Runs bytes, split into the given chunks, through the parser and the mapper, as the provider does. */
export function decodeChunks(chunks: readonly Uint8Array[]): StreamEvent[] {
  const parser = new SseParser()
  const mapper = new ResponsesStreamMapper()
  const events: StreamEvent[] = []
  for (const chunk of chunks) for (const frame of parser.push(chunk)) events.push(...mapper.frame(frame))
  for (const frame of parser.end()) events.push(...mapper.frame(frame))
  events.push(...mapper.end())
  return events
}

export function splitAt(bytes: Uint8Array, ...offsets: number[]): Uint8Array[] {
  const points = [0, ...offsets, bytes.length]
  return points.slice(1).map((end, index) => bytes.subarray(points[index], end))
}
