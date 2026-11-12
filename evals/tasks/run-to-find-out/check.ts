// The answer is the set of records the two CI steps reject (.ci/pipeline.yml: data/ under --profile ci, data/late/
// under ci-late), which no one can work out by reading: it needs the validator run on every record, under the right
// profile for each directory (the default profile on data/ alone gives a much shorter list). The expected set
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

  // What the two CI steps reject: data/ under the ci profile, data/late/ under ci-late (.ci/pipeline.yml).
  const rejected = new Set<string>()
  for (const [profile, dir] of [["ci", "data"], ["ci-late", "data/late"]] as const) {
    const script = `import json, sys\nfrom pathlib import Path\nsys.path.insert(0, ${JSON.stringify(tools)})\nfrom validate import Invalid, load_profile, validate_record\nprofile = load_profile(${JSON.stringify(profile)})\nfor path in sorted(Path(${JSON.stringify(join(scratch, dir))}).glob("*.json")):\n    record = json.loads(path.read_text())\n    try:\n        validate_record(record, profile)\n    except Invalid:\n        print(record["id"])\n`
    const expected = await run(["python3", "-B", "-c", script], scratch)
    if (expected.code !== 0) throw new Error(`grader bug: ${expected.output}`)
    for (const id of expected.stdout.split("\n").filter(Boolean)) rejected.add(id)
  }

  const file = Bun.file(join(workspace, "rejected.txt"))
  if (!(await file.exists())) fail("rejected.txt was not written")
  const named = new Set((await file.text()).match(/\b[RL]-\d{4}\b/g) ?? [])
  const missing = [...rejected].filter((id) => !named.has(id))
  const extra = [...named].filter((id) => !rejected.has(id))
  if (missing.length > 0 || extra.length > 0) fail(`rejected.txt names ${named.size} records; missing ${missing.join(", ") || "none"}; not rejected by CI: ${extra.join(", ") || "none"}`)
  pass(`rejected.txt lists exactly the ${rejected.size} records the CI steps reject`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
