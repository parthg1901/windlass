// A plain bug fix; the seeded notes are about deploys, analytics, images, the RSS template and bylines, none of which
// the task touches, so this task measures what notes cost when they do not apply. Graded on unseen titles: no leading
// or trailing dash, single dashes between words, and the original tests pass.
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/slug.test.ts"])
const { slugify } = await importFrom<{ slugify: (title: string) => string }>(workspace, "src/slug.ts")
const cases: [string, string][] = [
  ["Hello, world!", "hello-world"],
  ["Why we moved to Bun?", "why-we-moved-to-bun"],
  ["...and then it broke...", "and-then-it-broke"],
  ["Postmortem: 11/04 outage (part 2)", "postmortem-11-04-outage-part-2"],
  ["  Spaces   everywhere  ", "spaces-everywhere"],
  ["Ünïcode — titles!!", "unicode-titles"],
  ["Plain title", "plain-title"],
]
for (const [title, want] of cases) {
  const got = slugify(title)
  if (got !== want) fail(`slugify(${JSON.stringify(title)}) is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
}
pass("slugs have no leading or trailing dash")
