/**
 * Content-addressed media, shared by every session and every process.
 *
 * A blob is one file, `<dir>/<first two hex digits>/<sha256>`: a first line
 * with the media type, then the bytes. Sessions live in separate database
 * files, and a fork shows its parent's images, so blobs cannot live inside
 * any one of them.
 *
 * Several processes store blobs at once without a lock:
 * - The bytes are written to a temporary file in the same directory and then
 *   hard-linked to the final name. A link either creates the name or fails
 *   because it exists, so a reader never sees a half-written blob and the
 *   first writer's media type wins for everyone, as in the table this replaced.
 * - Two writers of the same bytes write the same content; the loser of the
 *   link only removes its temporary file.
 * - A temporary file left by a process that died is never read (its name is
 *   not a hash) and is removed by a later `put` once it is an hour old.
 */
import { createHash, randomBytes } from "node:crypto"
import { linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BlobRef } from "../content.ts"
import { nonEmptyString } from "../validate.ts"
import type { StoredBlob } from "./store.ts"

export interface BlobStore {
  /** Stores bytes under their SHA-256 and returns the reference. Storing the same bytes again returns the same reference. */
  readonly put: (bytes: Uint8Array, mediaType: string) => BlobRef
  readonly get: (hash: string) => StoredBlob | null
}

const HASH = /^[0-9a-f]{64}$/
const TEMPORARY = /^\.tmp-/
const STALE_MS = 3600_000

function checkedMediaType(mediaType: string): string {
  const checked = nonEmptyString(mediaType, "mediaType")
  if (/[\r\n]/.test(checked)) throw new TypeError("mediaType must be one line")
  return checked
}

/** Blobs as files under `dir`, safe for several processes at once. */
export function createFileBlobStore(dir: string): BlobStore {
  const pathOf = (hash: string) => join(dir, hash.slice(0, 2), hash)

  const read = (hash: string): StoredBlob | null => {
    const file = (() => {
      try {
        return readFileSync(pathOf(hash))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
        throw error
      }
    })()
    if (file === null) return null
    const end = file.indexOf(0x0a)
    if (end === -1) throw new Error(`blob ${hash} has no media type line`)
    return { hash, mediaType: file.subarray(0, end).toString("utf8"), bytes: new Uint8Array(file.subarray(end + 1)) }
  }

  /** Removes temporary files a dead process left in one shard. Best effort. */
  const sweep = (shard: string) => {
    try {
      const cutoff = Date.now() - STALE_MS
      for (const name of readdirSync(shard))
        if (TEMPORARY.test(name) && statSync(join(shard, name)).mtimeMs < cutoff) rmSync(join(shard, name), { force: true })
    } catch {}
  }

  return {
    put: (bytes, mediaType) => {
      const type = checkedMediaType(mediaType)
      const hash = createHash("sha256").update(bytes).digest("hex")
      const existing = read(hash)
      if (existing !== null) return { hash, mediaType: existing.mediaType }
      const shard = join(dir, hash.slice(0, 2))
      mkdirSync(shard, { recursive: true })
      const temporary = join(shard, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`)
      try {
        writeFileSync(temporary, Buffer.concat([Buffer.from(`${type}\n`, "utf8"), bytes]))
        try {
          linkSync(temporary, pathOf(hash))
        } catch (error) {
          // Another writer stored these bytes first: its media type is the one everybody gets.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
      } finally {
        rmSync(temporary, { force: true })
      }
      sweep(shard)
      return { hash, mediaType: read(hash)!.mediaType }
    },
    get: (hash) => (HASH.test(hash) ? read(hash) : null),
  }
}

/** Blobs in memory, for a store that is itself in memory. */
export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, StoredBlob>()
  return {
    put: (bytes, mediaType) => {
      const type = checkedMediaType(mediaType)
      const hash = createHash("sha256").update(bytes).digest("hex")
      const existing = blobs.get(hash)
      if (existing !== undefined) return { hash, mediaType: existing.mediaType }
      blobs.set(hash, { hash, mediaType: type, bytes: new Uint8Array(bytes) })
      return { hash, mediaType: type }
    },
    get: (hash) => blobs.get(hash) ?? null,
  }
}
