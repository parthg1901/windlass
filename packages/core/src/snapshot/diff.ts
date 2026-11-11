/** Parsing `git diff-tree` output: raw records into changes, and a patch stream into bounded per-file patches. */

export type FileKind = "file" | "executable" | "symlink" | "submodule"

export type FileState = { readonly kind: FileKind; readonly blob: string }

export type ChangeStatus = "added" | "deleted" | "modified" | "mode_changed" | "type_changed"

export type FilePatch =
  /** The `diff --git` section for the file: headers and hunks, cut at a line boundary when `truncated`. */
  | { readonly kind: "text"; readonly text: string; readonly truncated: boolean }
  /** git found a NUL byte in the first 8000 bytes of either side; the content is not shown. */
  | { readonly kind: "binary" }
  /** The total patch budget ran out before this file. */
  | { readonly kind: "omitted" }

export type FileChange = {
  /** Relative to the workspace, `/`-separated. */
  readonly path: string
  readonly status: ChangeStatus
  readonly before: FileState | null
  readonly after: FileState | null
  readonly patch?: FilePatch
}

export type PatchLimits = {
  /** Per file. Default 32 KiB. */
  readonly maxFileBytes?: number
  /** All files together; files after the budget is spent are `omitted`. Default 256 KiB. */
  readonly maxTotalBytes?: number
}

export const DEFAULT_PATCH_LIMITS = { maxFileBytes: 32 * 1024, maxTotalBytes: 256 * 1024 } as const

const ZERO = /^0+$/

function kindOf(mode: string): FileKind | null {
  switch (mode) {
    case "100644":
      return "file"
    case "100755":
      return "executable"
    case "120000":
      return "symlink"
    case "160000":
      return "submodule"
    default:
      return null
  }
}

/** `git diff-tree -r -z --no-renames` raw output: `:<mode> <mode> <oid> <oid> <status>\0<path>\0` per change. */
export function parseRaw(output: string): FileChange[] {
  const fields = output.split("\0")
  const changes: FileChange[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const meta = fields[index]!
    const path = fields[index + 1]!
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(meta)
    if (!match) throw new Error(`unexpected diff-tree record: ${JSON.stringify(meta)}`)
    const [, oldMode, newMode, oldBlob, newBlob, letter] = match as unknown as [string, string, string, string, string, string]
    const before = oldMode === "000000" || ZERO.test(oldBlob) ? null : state(oldMode, oldBlob)
    const after = newMode === "000000" || ZERO.test(newBlob) ? null : state(newMode, newBlob)
    changes.push({ path, status: statusOf(letter, before, after), before, after })
  }
  return changes
}

function state(mode: string, blob: string): FileState {
  const kind = kindOf(mode)
  if (kind === null) throw new Error(`unexpected mode ${mode}`)
  return { kind, blob }
}

function statusOf(letter: string, before: FileState | null, after: FileState | null): ChangeStatus {
  if (letter === "A" || before === null) return "added"
  if (letter === "D" || after === null) return "deleted"
  if (letter === "T") return "type_changed"
  return before.blob === after.blob ? "mode_changed" : "modified"
}

const decoder = new TextDecoder()

/**
 * Splits `git diff-tree -p` output into one section per change, in the same
 * order as the raw records. A line starting with `diff --git ` is always a
 * header: content lines carry a ` `, `+`, `-` or `\` prefix. A type change is
 * printed as a deletion and an addition, so it owns two sections.
 *
 * `complete` is false when the output was cut at the total budget: the last
 * section may be partial and later changes have no section.
 */
export function attachPatches(changes: FileChange[], output: Uint8Array, complete: boolean, limits: Required<PatchLimits>): FileChange[] {
  const starts: number[] = []
  const header = new TextEncoder().encode("diff --git ")
  for (let index = 0; index < output.length; index = output.indexOf(0x0a, index) + 1 || output.length) {
    if (startsWith(output, index, header)) starts.push(index)
  }
  let section = 0
  return changes.map((change) => {
    const count = change.status === "type_changed" ? 2 : 1
    const first = section
    section += count
    const end = section < starts.length ? starts[section]! : output.length
    if (first + count > starts.length) return { ...change, patch: { kind: "omitted" } as const }
    const bytes = output.subarray(starts[first]!, end)
    if (isBinary(bytes)) return { ...change, patch: { kind: "binary" } as const }
    const partial = !complete && section >= starts.length
    if (!partial && bytes.length <= limits.maxFileBytes) return { ...change, patch: { kind: "text", text: decoder.decode(bytes), truncated: false } as const }
    return { ...change, patch: { kind: "text", text: decoder.decode(cut(bytes, limits.maxFileBytes)), truncated: true } as const }
  })
}

function startsWith(bytes: Uint8Array, at: number, prefix: Uint8Array) {
  if (at + prefix.length > bytes.length) return false
  for (let index = 0; index < prefix.length; index += 1) if (bytes[at + index] !== prefix[index]) return false
  return true
}

/** git prints `Binary files a/x and b/x differ` (without --binary) in place of hunks. */
function isBinary(section: Uint8Array) {
  const text = decoder.decode(section.subarray(0, Math.min(section.length, 4096)))
  return text.split("\n").some((line) => line.startsWith("Binary files ") && line.endsWith(" differ"))
}

/** At most `max` bytes, ending at a newline when there is one, never inside a UTF-8 sequence. */
function cut(bytes: Uint8Array, max: number) {
  const head = bytes.subarray(0, max)
  const newline = head.lastIndexOf(0x0a)
  if (newline > 0) return head.subarray(0, newline + 1)
  let end = max
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end)
}
