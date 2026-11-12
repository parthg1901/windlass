#!/usr/bin/env bun
// Writes a small synthetic PNG for the image part of a dogfood pass: does the model receive an image the `read`
// tool returns, and describe it correctly? Nothing in it is a photograph; every pixel is computed here.
//
//   bun evals/dogfood/make-image.ts <out.png> [--pattern halves|digit|shapes] [--size <px>]
//
// Patterns, each with an answer a person can check against the model's description:
//   halves  left half red, right half blue (default)
//   digit   a large black "7" on a white background
//   shapes  a yellow circle in the top-left corner and a green square in the bottom-right, on white
// The image is `--size` pixels square (default 96). Uses node:zlib only.

import { writeFileSync } from "node:fs"
import { deflateSync } from "node:zlib"

const argv = process.argv.slice(2)
let out = ""
let pattern = "halves"
let size = 96
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!
  if (arg === "--pattern") pattern = argv[++index] ?? ""
  else if (arg === "--size") size = Number(argv[++index])
  else if (!arg.startsWith("-") && out === "") out = arg
  else usage()
}
if (out === "" || !["halves", "digit", "shapes"].includes(pattern) || !(size >= 8 && size <= 2048)) usage()

function usage(): never {
  console.error("usage: bun evals/dogfood/make-image.ts <out.png> [--pattern halves|digit|shapes] [--size <px>]")
  process.exit(2)
}

type Rgb = readonly [number, number, number]
const WHITE: Rgb = [255, 255, 255]

function pixel(x: number, y: number): Rgb {
  const u = x / size
  const v = y / size
  if (pattern === "halves") return u < 0.5 ? [220, 30, 30] : [30, 60, 220]
  if (pattern === "digit") {
    // A "7": a top bar and a diagonal stroke from its right end down to the bottom middle.
    const bar = v > 0.12 && v < 0.26 && u > 0.2 && u < 0.8
    const t = (v - 0.26) / (0.88 - 0.26)
    const stroke = t >= 0 && t <= 1 && Math.abs(u - (0.8 - t * 0.38)) < 0.08
    return bar || stroke ? [0, 0, 0] : WHITE
  }
  const circle = (u - 0.28) ** 2 + (v - 0.28) ** 2 < 0.18 ** 2
  const square = u > 0.58 && u < 0.9 && v > 0.58 && v < 0.9
  return circle ? [240, 200, 20] : square ? [30, 160, 60] : WHITE
}

const raw = Buffer.alloc((size * 3 + 1) * size)
for (let y = 0; y < size; y++) {
  const row = y * (size * 3 + 1)
  raw[row] = 0 // filter: none
  for (let x = 0; x < size; x++) {
    const [r, g, b] = pixel(x, y)
    raw[row + 1 + x * 3] = r
    raw[row + 2 + x * 3] = g
    raw[row + 3 + x * 3] = b
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0)
header.writeUInt32BE(size, 4)
header[8] = 8 // bit depth
header[9] = 2 // colour type: RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
])
writeFileSync(out, png)
console.log(`wrote ${out}: ${size}x${size} ${pattern}, ${png.length} bytes`)
