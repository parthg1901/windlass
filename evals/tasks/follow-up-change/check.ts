// Graded after the last turn: the function must do what both messages asked, and the existing helpers still work.
import { errorLine, fail, importFrom, pass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
// Adding slugify tests to the existing test file is reasonable, so the file may change.
// The existing helpers are checked directly below, and the suite must still pass.
const text = await importFrom<{ slugify?: unknown; titleCase: (text: string) => string; excerpt: (text: string, max: number) => string }>(workspace, "src/text.ts")
if (typeof text.slugify !== "function") fail("src/text.ts exports no slugify function")
const slugify = text.slugify as (title: string) => string
const cases: [string, string][] = [
  // The first message.
  ["Hello World", "hello-world"],
  ["  Many   spaces\there ", "many-spaces-here"],
  ["already-a-slug", "already-a-slug"],
  // The follow-up.
  ["Crème Brûlée!", "creme-brulee"],
  ["Ünïcödé 2026: Ready?", "unicode-2026-ready"],
  ["--Lead and trail--", "lead-and-trail"],
  ["C'est la vie, n'est-ce pas", "c-est-la-vie-n-est-ce-pas"],
  ["a -- b", "a-b"],
  ["Ångström & co", "angstrom-co"],
]
for (const [input, expected] of cases) {
  const actual = slugify(input)
  if (actual !== expected) fail(`slugify(${JSON.stringify(input)}) returned ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
if (text.titleCase("the quick fox") !== "The Quick Fox" || text.excerpt("a longer sentence", 9) !== "a longer…") fail("titleCase or excerpt changed behaviour")
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
pass("slugify does what both messages asked and the other helpers are intact")
