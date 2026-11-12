/**
 * What a file is, from its first bytes: one of the image formats the model
 * can be shown (with its pixel size when the header holds it), or a name for
 * another binary format. The extension is never consulted.
 */

/** The image formats the provider accepts. */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp"

export interface ImageInfo {
  readonly mediaType: ImageType
  /** The format's name, for a sentence. */
  readonly name: string
  /** `null` when the header does not say within the bytes read. */
  readonly width: number | null
  readonly height: number | null
}

/** Enough for every header below; a JPEG whose frame header comes later is reported without its size. */
export const SNIFF_BYTES = 64 * 1024

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))
const starts = (bytes: Uint8Array, ...values: number[]) => values.every((value, index) => bytes[index] === value)
const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!
const u16le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8)
const u24le = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0

/** The image `bytes` (the start of a file) begins, or `null`. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const size = (width: number | null, height: number | null) => (width !== null && height !== null && width > 0 && height > 0 ? { width, height } : { width: null, height: null })
  if (starts(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    const header = bytes.length >= 24 && ascii(bytes, 12, "IHDR")
    return { mediaType: "image/png", name: "PNG", ...size(header ? u32be(bytes, 16) : null, header ? u32be(bytes, 20) : null) }
  }
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))
    return { mediaType: "image/gif", name: "GIF", ...size(bytes.length >= 10 ? u16le(bytes, 6) : null, bytes.length >= 10 ? u16le(bytes, 8) : null) }
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return { mediaType: "image/webp", name: "WebP", ...size(...webpSize(bytes)) }
  if (starts(bytes, 0xff, 0xd8, 0xff)) return { mediaType: "image/jpeg", name: "JPEG", ...size(...jpegSize(bytes)) }
  return null
}

/**
 * Whether the whole file `bytes` is an animated GIF or an animated WebP. The
 * provider accepts still images only, and rejects the whole request for an
 * animated one, so `read` refuses it instead of attaching it.
 *
 * A GIF is animated when it holds more than one image: the blocks are walked
 * (each is skipped by its stated length, nothing is decoded) until the second
 * image descriptor or the trailer. A WebP says so in its `VP8X` header (the
 * animation flag). A file that ends early or does not parse counts as still:
 * what it is, is then the provider's to say.
 */
export function isAnimated(bytes: Uint8Array, image: Pick<ImageInfo, "mediaType">): boolean {
  if (image.mediaType === "image/webp") return ascii(bytes, 12, "VP8X") && bytes.length > 20 && (bytes[20]! & 0x02) !== 0
  if (image.mediaType !== "image/gif" || bytes.length < 13) return false
  const table = (flags: number) => ((flags & 0x80) !== 0 ? 3 * (1 << ((flags & 0x07) + 1)) : 0)
  /** Skips data sub-blocks (a length byte, then that many bytes; a zero length ends them). */
  const skipBlocks = (from: number) => {
    let at = from
    while (at < bytes.length && bytes[at] !== 0) at += bytes[at]! + 1
    return at + 1
  }
  let at = 13 + table(bytes[10]!)
  let images = 0
  while (at < bytes.length) {
    const kind = bytes[at]!
    if (kind === 0x2c) {
      images += 1
      if (images > 1) return true
      if (at + 10 > bytes.length) return false
      // The descriptor, its local colour table, the LZW code size, then the image data.
      at = skipBlocks(at + 10 + table(bytes[at + 9]!) + 1)
    } else if (kind === 0x21) at = skipBlocks(at + 2)
    else return false
  }
  return false
}

function webpSize(bytes: Uint8Array): [number | null, number | null] {
  if (ascii(bytes, 12, "VP8 ") && bytes.length >= 30 && starts(bytes.subarray(23), 0x9d, 0x01, 0x2a)) return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff]
  if (ascii(bytes, 12, "VP8L") && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1]
  }
  if (ascii(bytes, 12, "VP8X") && bytes.length >= 30) return [u24le(bytes, 24) + 1, u24le(bytes, 27) + 1]
  return [null, null]
}

/** The size in the first frame header (SOF0 to SOF15, not DHT, JPG or DAC), walking the segments. */
function jpegSize(bytes: Uint8Array): [number | null, number | null] {
  let at = 2
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return [null, null]
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [u16be(bytes, at + 7), u16be(bytes, at + 5)]
    // The start of scan or the end: no frame header before it.
    if (marker === 0xda || marker === 0xd9) return [null, null]
    at += 2 + u16be(bytes, at + 2)
  }
  return [null, null]
}

/** Known binary formats by their first bytes: [name, offset, signature]. */
const SIGNATURES: readonly (readonly [string, number, string | readonly number[]])[] = [
  ["a PDF document", 0, "%PDF-"],
  ["a ZIP archive (or a format built on one: .jar, .docx, .xlsx, .apk)", 0, [0x50, 0x4b, 0x03, 0x04]],
  ["an empty ZIP archive", 0, [0x50, 0x4b, 0x05, 0x06]],
  ["a gzip-compressed file", 0, [0x1f, 0x8b]],
  ["a bzip2-compressed file", 0, "BZh"],
  ["an xz-compressed file", 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ["a Zstandard-compressed file", 0, [0x28, 0xb5, 0x2f, 0xfd]],
  ["a 7-Zip archive", 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ["a tar archive", 257, "ustar"],
  ["an ELF executable or library", 0, [0x7f, 0x45, 0x4c, 0x46]],
  ["a Mach-O executable or library", 0, [0xcf, 0xfa, 0xed, 0xfe]],
  ["a Mach-O executable or library", 0, [0xce, 0xfa, 0xed, 0xfe]],
  ["a Mach-O universal binary or a Java class file", 0, [0xca, 0xfe, 0xba, 0xbe]],
  ["a Windows executable or library", 0, "MZ"],
  ["a WebAssembly module", 0, [0x00, 0x61, 0x73, 0x6d]],
  ["an SQLite database", 0, "SQLite format 3\u0000"],
  ["a BMP image, a format that cannot be shown", 0, "BM"],
  ["a TIFF image, a format that cannot be shown", 0, [0x49, 0x49, 0x2a, 0x00]],
  ["a TIFF image, a format that cannot be shown", 0, [0x4d, 0x4d, 0x00, 0x2a]],
  ["an icon file, a format that cannot be shown", 0, [0x00, 0x00, 0x01, 0x00]],
  ["a HEIF or AVIF image, a format that cannot be shown", 4, "ftypheic"],
  ["a HEIF or AVIF image, a format that cannot be shown", 4, "ftypavif"],
  ["an MP4 or QuickTime video or audio file", 4, "ftyp"],
  ["a WAV audio file", 8, "WAVE"],
  ["an AVI video", 8, "AVI "],
  ["an MP3 audio file", 0, "ID3"],
  ["an Ogg audio or video file", 0, "OggS"],
  ["a FLAC audio file", 0, "fLaC"],
  ["a Matroska or WebM video", 0, [0x1a, 0x45, 0xdf, 0xa3]],
  ["a WOFF font", 0, "wOFF"],
  ["a WOFF2 font", 0, "wOF2"],
  ["an OpenType font", 0, "OTTO"],
  ["a TrueType font", 0, [0x00, 0x01, 0x00, 0x00, 0x00]],
]

/** What kind of binary file `bytes` (the start of a file) appears to be, as a phrase. */
export function describeBinary(bytes: Uint8Array): string {
  for (const [name, at, signature] of SIGNATURES) {
    const matches = typeof signature === "string" ? ascii(bytes, at, signature) : signature.every((value, index) => bytes[at + index] === value)
    if (matches) return name
  }
  return "binary data of no format this tool knows"
}
