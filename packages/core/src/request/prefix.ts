/**
 * Block hashing and the prefix check (context rule 1): request N+1 must equal
 * request N plus appended blocks. The runtime request ledger and the CI gate
 * both call `comparePrefix`.
 */
import { createHash } from "node:crypto"
import { type Infer, array, integer, nonEmptyString, object, oneOf } from "../validate.ts"
import { canonicalJson } from "./canonical.ts"
import { BLOCK_KINDS, type BlockKind, type ModelRequest, type RequestBlock, requestBlocks } from "./request.ts"

/** One ledger entry per request block: what kind it was, the hash of its canonical JSON, and its size. */
export const blockHash = object({
  kind: oneOf(BLOCK_KINDS),
  /** Lowercase hex SHA-256 of the block's canonical JSON, UTF-8 encoded. */
  hash: nonEmptyString,
  /** UTF-8 byte length of the block's canonical JSON. For size attribution; not part of equality. */
  bytes: integer(0),
})
export type BlockHash = Infer<typeof blockHash>

export const blockHashes = array(blockHash)

export function hashBlock(block: RequestBlock): BlockHash {
  const canonical = canonicalJson(block)
  return {
    kind: block.kind,
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    bytes: Buffer.byteLength(canonical, "utf8"),
  }
}

/** The ordered block hashes of a request. This list is what the request ledger stores. */
export function hashRequest(request: ModelRequest): BlockHash[] {
  return requestBlocks(request).map(hashBlock)
}

export type PrefixComparison =
  /** Every previous block is still there, unchanged and in place. `appended` is 0 for an identical request. */
  | { readonly extension: true; readonly appended: number }
  | {
      readonly extension: false
      /** Position of the first block that differs. Everything before it is unchanged. */
      readonly index: number
      /**
       * The section of the request where it diverged. When the two blocks at
       * `index` are of different kinds (a tool was added, so a tool now sits
       * where the instructions were), this is the earlier section, which is the
       * one that actually changed.
       */
      readonly kind: BlockKind
      /** `changed`: a different block is at `index`. `removed`: the next request ends before `index`. */
      readonly change: "changed" | "removed"
      readonly previous: BlockHash
      readonly next: BlockHash | null
    }

/**
 * Reports whether `next` is `previous` plus appended blocks and, if not, the
 * first block that changed. Blocks are equal when their kind and hash are equal.
 */
export function comparePrefix(previous: readonly BlockHash[], next: readonly BlockHash[]): PrefixComparison {
  const index = previous.findIndex((block, position) => {
    const other = next[position]
    return other === undefined || other.kind !== block.kind || other.hash !== block.hash
  })
  if (index === -1) return { extension: true, appended: next.length - previous.length }
  const before = previous[index]!
  const after = next[index] ?? null
  return {
    extension: false,
    index,
    kind:
      after !== null && BLOCK_KINDS.indexOf(after.kind) < BLOCK_KINDS.indexOf(before.kind) ? after.kind : before.kind,
    change: after === null ? "removed" : "changed",
    previous: before,
    next: after,
  }
}
