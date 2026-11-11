import { describe, expect, test } from "bun:test"
import { type SseEvent, SseParser } from "../../src/provider/sse.ts"
import { fixtureBytes, splitAt, sseFixtures } from "./responses-helpers.ts"

const encoder = new TextEncoder()

function parseAll(chunks: readonly Uint8Array[]): SseEvent[] {
  const parser = new SseParser()
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()]
}

const parseText = (text: string) => parseAll([encoder.encode(text)])

describe("SseParser", () => {
  test("reads event and data fields, joins data lines and ignores comments, id and retry", () => {
    expect(parseText(": keep-alive\nevent: a\ndata: one\ndata:two\nid: 7\nretry: 10\n\n: keep-alive\n\ndata: {}\n\n")).toEqual([
      { event: "a", data: "one\ntwo" },
      { event: "message", data: "{}" },
    ])
  })

  test("accepts LF, CRLF and CR line endings and a leading BOM", () => {
    const expected = [
      { event: "x", data: "1" },
      { event: "y", data: "2" },
    ]
    expect(parseText("event: x\ndata: 1\n\nevent: y\ndata: 2\n\n")).toEqual(expected)
    expect(parseText("event: x\r\ndata: 1\r\n\r\nevent: y\r\ndata: 2\r\n\r\n")).toEqual(expected)
    expect(parseText("event: x\rdata: 1\r\revent: y\rdata: 2\r\r")).toEqual(expected)
    expect(parseText("﻿event: x\ndata: 1\n\nevent: y\ndata: 2\n\n")).toEqual(expected)
  })

  test("a CRLF split between chunks is one line ending, not two", () => {
    const bytes = encoder.encode("data: a\r\n\r\ndata: b\r\n\r\n")
    for (let offset = 0; offset <= bytes.length; offset++)
      expect(parseAll(splitAt(bytes, offset))).toEqual([
        { event: "message", data: "a" },
        { event: "message", data: "b" },
      ])
  })

  test("frames with only comments or an event name dispatch nothing", () => {
    expect(parseText("event: lonely\n\n: c\n\n")).toEqual([])
  })

  test("at end of input a complete last line is dispatched but a cut line is dropped", () => {
    expect(parseText("data: whole\n")).toEqual([{ event: "message", data: "whole" }])
    expect(parseText('data: {"cut')).toEqual([])
    expect(parseText("data: whole\ndata: cu")).toEqual([{ event: "message", data: "whole" }])
  })

  test("multi-byte UTF-8 split at every byte offset decodes intact", () => {
    const text = "data: Café — 東京 🌧️ ✓\n\n"
    const bytes = encoder.encode(text)
    for (let offset = 0; offset <= bytes.length; offset++)
      expect(parseAll(splitAt(bytes, offset))).toEqual([{ event: "message", data: "Café — 東京 🌧️ ✓" }])
  })

  for (const name of sseFixtures) {
    test(`${name}: every two-way split and one-byte chunks give the same frames as one chunk`, async () => {
      const bytes = await fixtureBytes(name)
      const whole = parseAll([bytes])
      expect(whole.length).toBeGreaterThan(0)
      // Every frame's event name matches its JSON type, as observed live.
      for (const frame of whole) expect((JSON.parse(frame.data) as { type: string }).type).toBe(frame.event)
      for (let offset = 1; offset < bytes.length; offset++) expect(parseAll(splitAt(bytes, offset))).toEqual(whole)
      const bytewise = Array.from({ length: bytes.length }, (_, index) => bytes.subarray(index, index + 1))
      expect(parseAll(bytewise)).toEqual(whole)
    })
  }
})
