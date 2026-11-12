import { afterEach, describe, expect, test } from "bun:test"
import type { BlobRef } from "../../src/content.ts"
import { createToolRuntime } from "../../src/tool/runtime.ts"
import { createStandardTools } from "../../src/tools/index.ts"
import { MAX_IMAGE_BYTES } from "../../src/tools/read.ts"
import { context, removeTempDirs, tempDir, workspace } from "./helpers.ts"

afterEach(removeTempDirs)

const bytes = (...parts: (number[] | string)[]) => new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part)))
const be32 = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
const le16 = (value: number) => [value & 0xff, value >>> 8]
const le24 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, value >>> 16]

/** Headers with a few bytes after them: enough for the sniffing, not decodable images. */
const PNG = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(640), be32(480), [8, 6, 0, 0, 0], [1, 2, 3, 4])
const JPEG = bytes([0xff, 0xd8], [0xff, 0xe0], [0, 16], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xdb], [0, 4, 0, 0], [0xff, 0xc0], [0, 11, 8], [0, 200], [1, 44], [1, 1, 0x11, 0], [0xff, 0xd9])
const GIF = bytes("GIF89a", le16(32), le16(16), [0, 0, 0], ";")
const WEBP_LOSSY = bytes("RIFF", [30, 0, 0, 0], "WEBP", "VP8 ", [18, 0, 0, 0], [0, 0, 0], [0x9d, 0x01, 0x2a], le16(100), le16(50), [0, 0])
// VP8L: 14 bits each of width - 1 and height - 1 after the 0x2f signature.
const vp8lBits = (63 - 1) | ((31 - 1) << 14)
const WEBP_LOSSLESS = bytes("RIFF", [26, 0, 0, 0], "WEBP", "VP8L", [13, 0, 0, 0], [0x2f], [vp8lBits & 0xff, (vp8lBits >>> 8) & 0xff, (vp8lBits >>> 16) & 0xff, vp8lBits >>> 24], [0, 0])
const WEBP_EXTENDED = bytes("RIFF", [30, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0, 0, 0, 0], le24(1920 - 1), le24(1080 - 1), [0, 0])

/** A workspace whose runtime stores blobs in a map, the way the session's store does. */
function imageWorkspace() {
  const ws = workspace()
  const blobs = new Map<string, Uint8Array>()
  const putBlob = (data: Uint8Array, mediaType: string): BlobRef => {
    const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex")
    blobs.set(hash, data)
    return { hash, mediaType }
  }
  const spillDir = tempDir()
  const runtime = createToolRuntime({ tools: createStandardTools({ spillDir }), spillDir, putBlob })
  const read = (path: string) => runtime.run({ name: "read", argumentsText: JSON.stringify({ path }), context: context(ws.root) })
  return { ws, blobs, read }
}

describe("read: images", () => {
  const cases = [
    { name: "shot.png", data: PNG, expected: "shot.png: PNG image (image/png), 640x480 pixels" },
    { name: "photo.jpg", data: JPEG, expected: "photo.jpg: JPEG image (image/jpeg), 300x200 pixels" },
    { name: "anim.gif", data: GIF, expected: "anim.gif: GIF image (image/gif), 32x16 pixels" },
    { name: "lossy.webp", data: WEBP_LOSSY, expected: "lossy.webp: WebP image (image/webp), 100x50 pixels" },
    { name: "lossless.webp", data: WEBP_LOSSLESS, expected: "lossless.webp: WebP image (image/webp), 63x31 pixels" },
    { name: "extended.webp", data: WEBP_EXTENDED, expected: "extended.webp: WebP image (image/webp), 1920x1080 pixels" },
    // The first bytes decide, not the name.
    { name: "notes.txt", data: PNG, expected: "notes.txt: PNG image (image/png), 640x480 pixels" },
  ]
  for (const { name, data, expected } of cases)
    test(`${name} is attached with one line that says what it is`, async () => {
      const { ws, blobs, read } = imageWorkspace()
      await ws.write(name, data)
      const { settlement } = await read(name)
      const mediaType = expected.match(/\((image\/[a-z]+)\)/)![1]!
      expect(settlement.outcome).toBe("success")
      expect(settlement.output).toBe(`${expected}, ${data.length} bytes, attached.`)
      expect(settlement.attachments).toEqual([{ hash: new Bun.CryptoHasher("sha256").update(data).digest("hex"), mediaType }])
      expect(blobs.get(settlement.attachments[0]!.hash)).toEqual(data)
      expect(settlement.truncation).toBeNull()
    })

  test("an image whose header gives no size is attached without one", async () => {
    const { ws, read } = imageWorkspace()
    // A JPEG cut off before its frame header.
    await ws.write("cut.jpg", JPEG.subarray(0, 24))
    expect((await read("cut.jpg")).settlement.output).toBe("cut.jpg: JPEG image (image/jpeg), 24 bytes, attached.")
  })

  test("a text file named .png is read as text", async () => {
    const { ws, read } = imageWorkspace()
    await ws.write("fake.png", "not an image\n")
    expect((await read("fake.png")).settlement).toMatchObject({ outcome: "success", output: "1\tnot an image", attachments: [] })
  })

  test("an image over the size limit is refused with what to do", async () => {
    const { ws, blobs, read } = imageWorkspace()
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1)
    big.set(PNG)
    await ws.write("huge.png", big)
    const { settlement } = await read("huge.png")
    expect(settlement.outcome).toBe("error")
    expect(settlement.output).toBe(
      `Cannot show huge.png: it is a PNG image, 640x480 pixels of ${MAX_IMAGE_BYTES + 1} bytes, over the limit of ${MAX_IMAGE_BYTES} bytes (5 MB) for an image. Make a smaller copy (scaled down or more compressed) and read that.`,
    )
    expect(settlement.attachments).toEqual([])
    expect(blobs.size).toBe(0)
  })

  test("where no blob store exists the image is refused, not crashed on", async () => {
    const ws = workspace()
    await ws.write("shot.png", PNG)
    const { settlement } = await ws.call("read", { path: "shot.png" })
    expect(settlement.outcome).toBe("error")
    expect(settlement.output).toStartWith("Cannot show shot.png (a PNG image): images cannot be attached here (")
  })

  test("other binary files stay refused, saying what they appear to be", async () => {
    const { ws, read } = imageWorkspace()
    const files: [string, Uint8Array, string][] = [
      ["a.zip", bytes("PK", [3, 4, 20, 0, 0, 0]), "a ZIP archive (or a format built on one: .jar, .docx, .xlsx, .apk)"],
      ["prog", bytes([0x7f], "ELF", [2, 1, 1, 0]), "an ELF executable or library"],
      ["doc.pdf", bytes("%PDF-1.7\n", [0, 1]), "a PDF document"],
      ["pic.bmp", bytes("BM", [0, 0, 0, 0]), "a BMP image, a format that cannot be shown"],
      ["data.db", bytes("SQLite format 3", [0]), "an SQLite database"],
      ["x.gz", bytes([0x1f, 0x8b, 8, 0]), "a gzip-compressed file"],
      ["blob", bytes([1, 2, 0, 3]), "binary data of no format this tool knows"],
    ]
    for (const [name, data, kind] of files) {
      await ws.write(name, data)
      const { settlement } = await read(name)
      expect(settlement).toMatchObject({
        outcome: "error",
        output: `Cannot read ${name}: it appears to be ${kind} (${data.length} bytes). read shows text files and PNG, JPEG, GIF and WebP images.`,
        attachments: [],
      })
    }
  })
})

describe("read: animated images", () => {
  /** One frame of a GIF: a graphic control extension, an image descriptor, and one data sub-block. */
  const frame = bytes([0x21, 0xf9, 0x04, 0, 10, 0, 0, 0], [0x2c], le16(0), le16(0), le16(2), le16(2), [0], [2], [2, 0x4c, 0x01], [0])
  /** The header with a two-colour global table, which the walk must skip. */
  const head = bytes("GIF89a", le16(2), le16(2), [0x80, 0, 0], [0, 0, 0, 255, 255, 255])
  const loop = bytes([0x21, 0xff, 11], "NETSCAPE2.0", [3, 1, 0, 0], [0])
  const STILL = bytes([...head], [...frame], ";")
  const ANIMATED = bytes([...head], [...loop], [...frame], [...frame], ";")
  const WEBP_ANIMATED = bytes("RIFF", [30, 0, 0, 0], "WEBP", "VP8X", [10, 0, 0, 0], [0x02, 0, 0, 0], le24(64 - 1), le24(64 - 1), [0, 0])

  test("a GIF with one image is attached, whatever extensions it carries", async () => {
    const { ws, blobs, read } = imageWorkspace()
    await ws.write("still.gif", STILL)
    expect(await read("still.gif")).toMatchObject({ kind: "completed", settlement: { outcome: "success", output: `still.gif: GIF image (image/gif), 2x2 pixels, ${STILL.length} bytes, attached.` } })
    expect(blobs.size).toBe(1)
  })

  test("an animated GIF is refused with what to do, and nothing is attached", async () => {
    const { ws, blobs, read } = imageWorkspace()
    await ws.write("spinner.gif", ANIMATED)
    expect(await read("spinner.gif")).toMatchObject({
      kind: "completed",
      settlement: { outcome: "error", output: "Cannot show spinner.gif: it is an animated GIF image, 2x2 pixels, and only still images can be shown. Save one frame of it as a PNG and read that.", attachments: [] },
    })
    expect(blobs.size).toBe(0)
  })

  test("an animated WebP is refused the same way", async () => {
    const { ws, blobs, read } = imageWorkspace()
    await ws.write("spinner.webp", WEBP_ANIMATED)
    expect(await read("spinner.webp")).toMatchObject({ kind: "completed", settlement: { outcome: "error", output: expect.stringContaining("it is an animated WebP image, 64x64 pixels") } })
    expect(blobs.size).toBe(0)
  })

  test("a GIF that ends in the middle of a block counts as still: the provider says what it is", async () => {
    const { ws, read } = imageWorkspace()
    await ws.write("cut.gif", ANIMATED.subarray(0, head.length + loop.length + 12))
    expect(await read("cut.gif")).toMatchObject({ kind: "completed", settlement: { outcome: "success" } })
  })

  test("the description says that read shows images", () => {
    const tool = createStandardTools({ spillDir: tempDir() }).find((candidate) => candidate.name === "read")!
    expect(tool.description).toContain("PNG, JPEG, GIF or WebP image (not animated, at most 5 MB)")
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024)
  })
})
