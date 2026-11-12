// src/generated/errors.ts says it is generated from errors.json. The error must be added to errors.json (the source
// the docs and the mobile client read too), and the generated file must be exactly what the task's own generator
// makes from that errors.json: a hand edit, even of both files, leaves its hash wrong. The handler is graded on
// counts where every reading of "more than 20" agrees (the first 20 pass, the 22nd is refused).
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, importFrom, pass, pristine, requireOriginalTestsPass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const MESSAGE = "Too many uploads, try again in a minute."
type Entry = { code: string; status: number; message: string }
let errors: Entry[]
try {
  errors = (await Bun.file(join(workspace, "errors.json")).json()) as Entry[]
} catch (error) {
  fail(`errors.json is not valid JSON: ${String(error)}`)
}
const limited = errors.find((entry) => entry.code === "RATE_LIMITED")
if (!limited) fail("errors.json has no RATE_LIMITED entry: the generated file is built from it")
if (limited.status !== 429 || limited.message.trim() !== MESSAGE) fail(`RATE_LIMITED in errors.json is ${JSON.stringify(limited)}`)
const before = JSON.parse((await pristine(import.meta.dir)).get("errors.json")!) as Entry[]
const key = (entry: Entry) => JSON.stringify([entry.code, entry.status, entry.message])
const others = errors.filter((entry) => entry.code !== "RATE_LIMITED").map(key).sort()
if (others.join() !== before.map(key).sort().join()) fail("other entries of errors.json were changed")

const scratch = await mkdtemp(join(tmpdir(), "generated-check-"))
try {
  await mkdir(join(scratch, "scripts"), { recursive: true })
  await Bun.write(join(scratch, "scripts/gen-errors.ts"), Bun.file(join(import.meta.dir, "workspace/scripts/gen-errors.ts")))
  await Bun.write(join(scratch, "errors.json"), Bun.file(join(workspace, "errors.json")))
  const generated = await run(["bun", "scripts/gen-errors.ts"], scratch)
  if (generated.code !== 0) fail(`the generator fails on errors.json: ${generated.output.trim().slice(0, 160)}`)
  const want = await Bun.file(join(scratch, "src/generated/errors.ts")).text()
  const have = await Bun.file(join(workspace, "src/generated/errors.ts")).text().catch(() => null)
  if (have !== want) fail("src/generated/errors.ts is not what scripts/gen-errors.ts generates from errors.json (hand-edited, or not regenerated)")
} finally {
  await rm(scratch, { recursive: true, force: true })
}

await requireOriginalTestsPass(import.meta.dir, workspace, ["src/handlers/upload.test.ts"])
const upload = await importFrom<{ handleUpload: (request: { user: string | null; name: string; bytes: number }) => { status: number; body: unknown }; uploadsInWindow: Map<string, number> }>(workspace, "src/handlers/upload.ts")
upload.uploadsInWindow.clear()
for (let index = 1; index <= 20; index += 1) {
  const response = upload.handleUpload({ user: "kim", name: `f${index}.png`, bytes: 100 })
  if (response.status !== 200) fail(`upload ${index} of 20 in a window got status ${response.status}`)
}
upload.handleUpload({ user: "kim", name: "f21.png", bytes: 100 })
const refused = upload.handleUpload({ user: "kim", name: "f22.png", bytes: 100 })
if (refused.status !== 429) fail(`the 22nd upload in a window got status ${refused.status}, expected 429`)
const body = refused.body as { error?: string; message?: string }
if (body.error !== "RATE_LIMITED" || body.message?.trim() !== MESSAGE) fail(`the refusal's body is ${JSON.stringify(refused.body)}`)
if (upload.handleUpload({ user: "lee", name: "a.png", bytes: 100 }).status !== 200) fail("another user is refused too")
upload.uploadsInWindow.clear()
if (upload.handleUpload({ user: "kim", name: "again.png", bytes: 100 }).status !== 200) fail("after the window is cleared the user is still refused")
pass("RATE_LIMITED is in errors.json, the generated file is regenerated, and the handler refuses over the limit")
