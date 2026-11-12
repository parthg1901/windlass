// The fix is graded on inputs the agent has not seen. The changelog entry must be a fragment for issue 482 that the
// release script picks up (changes/482.<feature|fix|docs|removal>.md, non-empty), and CHANGELOG.md, which says at its
// end that it is assembled from the fragments, must be as it was.
import { join } from "node:path"
import { fail, importFrom, pass, readTree, requireOriginalTestsPass, requireUnchanged, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/paginate.test.ts"])
const { paginate } = await importFrom<{ paginate: (items: number[], page: number, size: number) => { items: number[]; page: number; pages: number } }>(workspace, "src/paginate.ts")
const list = Array.from({ length: 7 }, (_, index) => index + 1)
for (const [page, size, want] of [[3, 3, [7]], [2, 4, [5, 6, 7]], [1, 10, [1, 2, 3, 4, 5, 6, 7]], [4, 2, [7]], [2, 3, [4, 5, 6]], [5, 2, []]] as const) {
  const got = paginate(list, page, size).items
  if (JSON.stringify(got) !== JSON.stringify(want)) fail(`paginate(1..7, ${page}, ${size}) gives ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
await requireUnchanged(import.meta.dir, workspace, ["CHANGELOG.md"])
const changes = await readTree(join(workspace, "changes"))
const fragment = [...changes.keys()].find((name) => /^482\.(feature|fix|docs|removal)\.md$/.test(name))
if (!fragment) fail(`there is no changes/482.<type>.md fragment (changes/ has ${[...changes.keys()].join(", ")})`)
if (changes.get(fragment)!.trim().length < 10) fail(`changes/${fragment} is empty`)
for (const old of ["479.fix.md", "481.feature.md"]) if (!changes.has(old)) fail(`changes/${old} was removed`)
pass("paginate is fixed and the changelog fragment is in changes/")
