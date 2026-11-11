// Writes src/commands.ts: about 2,400 small command handlers (some 30,000 lines). Deterministic, so a grader can
// regenerate the original and compare.
//   bun gen.ts [<output-dir>]
import { join } from "node:path"

const VERBS = ["archive", "unarchive", "lock", "unlock", "tag", "untag", "flag", "unflag", "touch", "rename", "close", "reopen"]
const NOUNS = ["invoice", "order", "customer", "ticket", "shipment", "refund", "payment", "coupon", "supplier", "warehouse", "report", "contract", "quote", "subscription", "voucher", "batch", "return", "receipt", "account", "project"]
const VARIANTS = ["", "-draft", "-bulk", "-legacy", "-v2", "-test", "-archived", "-pending", "-eu", "-us"]

function body(verb: string, noun: string): string[] {
  switch (verb) {
    case "archive":
      return ["record.archived = true", "record.history.push(`archived ${record.id}`)"]
    case "unarchive":
      return ["record.archived = false", "record.history.push(`unarchived ${record.id}`)"]
    case "lock":
      return ["record.locked = true"]
    case "unlock":
      return ["record.locked = false"]
    case "tag":
      return [`if (!record.tags.includes("${noun}")) record.tags.push("${noun}")`]
    case "untag":
      return [`record.tags = record.tags.filter((tag) => tag !== "${noun}")`]
    case "flag":
      return ["record.flagged = true"]
    case "unflag":
      return ["record.flagged = false"]
    case "touch":
      return ["record.version += 1"]
    case "rename":
      return ["record.name = record.name.trim()"]
    case "close":
      return ["record.open = false"]
    default:
      return ["record.open = true"]
  }
}

export function generate(): string {
  const out = [
    "// Command handlers. Each takes the record, changes it in place and returns whether it ran.",
    'import type { Rec } from "./record.ts"',
    "",
    "export const COMMANDS = new Map<string, (record: Rec) => { ok: boolean }>()",
    "",
  ]
  // Shuffled by a fixed hash, so no handler sits where reading the top or the bottom of the file would find it.
  const names = VARIANTS.flatMap((variant) => NOUNS.flatMap((noun) => VERBS.map((verb) => ({ verb, noun, name: `${verb}-${noun}${variant}` }))))
  for (const { verb, noun, name } of names.toSorted((a, b) => hash(a.name) - hash(b.name) || a.name.localeCompare(b.name))) {
    const lines = body(verb, noun)
    // The one bug: a comparison where an assignment was meant, so the command does nothing and still says ok.
    if (name === "archive-invoice") lines[0] = "record.archived === true"
    out.push(
      `COMMANDS.set("${name}", (record) => {`,
      "  if (record.deleted) return { ok: false }",
      ...lines.map((line) => `  ${line}`),
      "  record.updatedBy = " + JSON.stringify(name),
      "  return { ok: true }",
      "})",
      "",
    )
  }
  return out.join("\n")
}

/** FNV-1a, 32 bits. */
function hash(text: string) {
  let value = 0x811c9dc5
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193) >>> 0
  return value
}

if (import.meta.main) await Bun.write(join(process.argv[2] ?? import.meta.dir, "src", "commands.ts"), generate())
