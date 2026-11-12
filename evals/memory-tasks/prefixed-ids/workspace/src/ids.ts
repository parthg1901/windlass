// IDs look like `cmt_0lx3k2a9f1q8`: a prefix naming the kind of record, then the time and some randomness, so they
// sort by creation. The support console and the log search read the prefix to know what an ID points at.

export const PREFIXES = {
  usr: "user",
  thr: "thread",
  cmt: "comment",
  att: "attachment",
} as const

export type Prefix = keyof typeof PREFIXES

let last = ""

export function newId(prefix: Prefix): string {
  if (!(prefix in PREFIXES)) throw new Error(`unknown id prefix ${prefix}`)
  let id = ""
  do {
    id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  } while (id === last)
  last = id
  return id
}

/** What an ID names (`"comment"`), or `null` for an ID that is not one of ours. */
export function kindOf(id: string): string | null {
  const prefix = id.split("_")[0] as Prefix
  return PREFIXES[prefix] ?? null
}
