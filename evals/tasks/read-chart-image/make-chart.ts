#!/usr/bin/env bun
// Writes workspace/docs/cpu-last-night.png: a bar chart of peak CPU per service, labelled in a 5x7 pixel font. The
// answer to the task (highest: worker, lowest: cron) is in this image only. Kept here, outside the workspace, so the
// agent cannot read the numbers from the generator; graders.test.ts checks the committed PNG is what this makes.
//
//   bun evals/tasks/read-chart-image/make-chart.ts [out.png]
import { join } from "node:path"
import { deflateSync } from "node:zlib"

export const BARS = [
  { label: "API", percent: 47 },
  { label: "WORKER", percent: 91 },
  { label: "CRON", percent: 12 },
  { label: "WEB", percent: 68 },
] as const

const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
}

const WIDTH = 360
const HEIGHT = 230
const TOP = 30
const BASE = 190
type Rgb = readonly [number, number, number]

export function render(): Buffer {
  const pixels: Rgb[] = Array.from({ length: WIDTH * HEIGHT }, () => [255, 255, 255] as const)
  const set = (x: number, y: number, colour: Rgb) => {
    if (x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT) pixels[y * WIDTH + x] = colour
  }
  const rect = (x0: number, y0: number, w: number, h: number, colour: Rgb) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, colour)
  }
  const text = (value: string, x0: number, y0: number, scale: number) => {
    for (const [index, char] of [...value].entries()) {
      const glyph = FONT[char]!
      for (let row = 0; row < 7; row++) for (let col = 0; col < 5; col++) if (glyph[row]![col] === "1") rect(x0 + (index * 6 + col) * scale, y0 + row * scale, scale, scale, [20, 20, 20])
    }
  }
  // Grid lines at 25, 50, 75 and 100 percent, and the axis.
  for (const step of [25, 50, 75, 100]) rect(30, BASE - Math.round(((BASE - TOP) * step) / 100), WIDTH - 40, 1, [210, 210, 210])
  rect(30, BASE, WIDTH - 40, 2, [60, 60, 60])
  text("CPU%", 8, 6, 2)
  for (const [index, bar] of BARS.entries()) {
    const height = Math.round(((BASE - TOP) * bar.percent) / 100)
    const x = 50 + index * 78
    rect(x, BASE - height, 44, height, [52, 101, 164])
    const labelWidth = bar.label.length * 6 * 2 - 2
    text(bar.label, x + 22 - Math.floor(labelWidth / 2), BASE + 10, 2)
  }
  const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) {
    raw[y * (WIDTH * 3 + 1)] = 0
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = pixels[y * WIDTH + x]!
      const at = y * (WIDTH * 3 + 1) + 1 + x * 3
      raw[at] = r
      raw[at + 1] = g
      raw[at + 2] = b
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(WIDTH, 0)
  header.writeUInt32BE(HEIGHT, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

if (import.meta.main) {
  const out = process.argv[2] ?? join(import.meta.dir, "workspace/docs/cpu-last-night.png")
  await Bun.write(out, render())
  console.log(`wrote ${out}`)
}
