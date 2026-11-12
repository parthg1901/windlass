// The answer is the set of records the CI profile rejects (16 of 60), which no one can work out by reading: it
// needs the validator run on every record, under --profile ci (the default profile rejects only 7). The expected set
// is computed here with the task's own, untouched validator and generator, so an edited copy in the workspace
// changes nothing.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fail, pass, readTree, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const tools = join(import.meta.dir, "workspace", "tools")
const scratch = await mkdtemp(join(tmpdir(), "run-to-find-out-"))
try {
  // The data must be exactly what the generator writes.
  const generated = await run(["python3", "-B", join(tools, "gen_fixture.py")], scratch)
  if (generated.code !== 0) throw new Error(`grader bug: the generator failed: ${generated.output}`)
  const want = await readTree(join(scratch, "data"))
  const have = await readTree(join(workspace, "data"))
  for (const [path, text] of want) {
    if (have.get(path) !== text) fail(`data/${path} was changed or deleted`)
  }
  if (have.size !== want.size) fail("files were added to data/")

  const script = `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(tools)})\nfrom validate import Invalid, load_profile, validate_record\nprofile = load_profile("ci")\nfor path in sorted(Path(${JSON.stringify(join(scratch, "data"))}).glob("*.json")):\n    record = json.loads(path.read_text())\n    try:\n        validate_record(record, profile)\n    except Invalid:\n        print(record["id"])\n`
  const expected = await run(["python3", "-B", "-c", script], scratch)
  if (expected.code !== 0) throw new Error(`grader bug: ${expected.output}`)
  const rejected = new Set(expected.stdout.split("\n").filter(Boolean))

  const file = Bun.file(join(workspace, "rejected.txt"))
  if (!(await file.exists())) fail("rejected.txt was not written")
  const named = new Set((await file.text()).match(/R-\d{4}/g) ?? [])
  const missing = [...rejected].filter((id) => !named.has(id))
  const extra = [...named].filter((id) => !rejected.has(id))
  if (missing.length > 0 || extra.length > 0) fail(`rejected.txt names ${named.size} records; missing ${missing.join(", ") || "none"}; not rejected by CI: ${extra.join(", ") || "none"}`)
  pass(`rejected.txt lists exactly the ${rejected.size} records CI rejects`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
