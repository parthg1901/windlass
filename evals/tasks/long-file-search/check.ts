// The command must work, and src/commands.ts must differ from the generated original only near that one handler.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brand } from "../../../packages/core/src/brand.ts"
import { fail, importFrom, pass, requireUnchanged, run, workspaceArg } from "../../grader.ts"

type Rec = Record<string, unknown> & { archived: boolean; locked: boolean; history: string[]; deleted: boolean }
const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["src/record.ts", "cli.ts"])
const { COMMANDS } = await importFrom<{ COMMANDS: Map<string, (record: Rec) => { ok: boolean }> }>(workspace, "src/commands.ts")
const { sample } = await importFrom<{ sample: (id: string) => Rec }>(workspace, "src/record.ts")

const archive = COMMANDS.get("archive-invoice")
if (!archive) fail("archive-invoice is no longer registered")
const record = sample("inv-9")
if (!archive(record).ok || record.archived !== true) fail("archive-invoice still does not archive the record")
if (!record.history.includes("archived inv-9")) fail("archive-invoice no longer records its history entry")
const deleted = { ...sample("inv-10"), deleted: true }
if (archive(deleted).ok || deleted.archived) fail("archive-invoice now archives deleted records")
for (const [name, field, value] of [["archive-order", "archived", true], ["lock-invoice", "locked", true], ["unarchive-invoice", "archived", false]] as const) {
  const other = { ...sample("x"), archived: name === "unarchive-invoice" }
  if (!COMMANDS.get(name)?.(other).ok || other[field] !== value) fail(`${name} broke`)
}

const original = await mkdtemp(join(tmpdir(), `${brand.binary}-long-file-`))
const generated = await run(["bun", join(import.meta.dir, "workspace", "gen.ts"), original], workspace)
if (generated.code !== 0) throw new Error(`grader bug: could not regenerate commands.ts: ${generated.output}`)
const before = (await Bun.file(join(original, "src", "commands.ts")).text()).split("\n")
await rm(original, { recursive: true, force: true })
const after = (await Bun.file(join(workspace, "src", "commands.ts")).text()).split("\n")
// Lines outside the handler must be untouched: compare the common head and tail.
const head = before.findIndex((line, index) => line !== after[index])
const tail = before.toReversed().findIndex((line, index) => line !== after[after.length - 1 - index])
if (head === -1 && before.length === after.length) fail("src/commands.ts is unchanged")
const changedBefore = before.length - head - tail
const changedAfter = after.length - head - tail
if (changedBefore > 8 || changedAfter > 12) fail(`the change to src/commands.ts spans ${changedBefore} original lines (${changedAfter} new); keep it to the one handler`)
if (!before.slice(head, before.length - tail).join("\n").includes("archive-invoice") && !before.slice(Math.max(0, head - 6), head + 1).join("\n").includes("archive-invoice"))
  fail("src/commands.ts changed somewhere other than the archive-invoice handler")
pass("archive-invoice archives, and only its handler changed")
