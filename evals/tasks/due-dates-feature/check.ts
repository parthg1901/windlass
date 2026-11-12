// Drives the CLI as a user would (bun src/cli.ts, with TASKS_FILE and TASKS_TODAY) through scenarios the agent has
// not seen and compares the list output line by line. Only behaviour the prompt fixes is checked: what `add` prints,
// what an empty --overdue list prints and other date formats are left open.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorLine, fail, pass, readTree, requireOriginalTestsPass, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/cli.test.ts"])
const scratch = await mkdtemp(join(tmpdir(), "due-dates-"))
try {
  const file = join(scratch, "tasks.json")
  const cli = async (args: string[], today = "2026-03-10") => {
    const proc = Bun.spawn(["bun", join(workspace, "src/cli.ts"), ...args], { cwd: scratch, env: { ...process.env, TASKS_FILE: file, TASKS_TODAY: today, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    return { code, stdout: stdout.split("\n").map((line) => line.trimEnd()).filter((line) => line !== ""), stderr }
  }
  // The prompt fixes the order of `list`; for `list --overdue` it does not, so its lines are compared as a set.
  const expectList = async (args: string[], want: string[], what: string, today?: string) => {
    const out = await cli(args, today)
    if (out.code !== 0) fail(`${what}: exit ${out.code}: ${out.stderr.trim().slice(0, 120)}`)
    const ordered = !args.includes("--overdue")
    const shape = (lines: string[]) => (ordered ? lines : [...lines].sort()).join("\n")
    if (shape(out.stdout) !== shape(want)) fail(`${what}: got ${JSON.stringify(out.stdout)}, expected ${JSON.stringify(want)}${ordered ? "" : " in any order"}`)
  }

  // An existing file from before due dates.
  await Bun.write(file, `${JSON.stringify({ version: 1, tasks: [{ id: 1, title: "Old task", done: false }, { id: 2, title: "Old done", done: true, completedAt: "2026-01-02" }] }, null, 2)}\n`)
  await expectList(["list"], ["[ ] 1 Old task", "[x] 2 Old done"], "list on a file without due dates")
  await rm(file, { force: true })

  for (const args of [["add", "Write report"], ["add", "Pay rent", "--due", "2026-03-20"], ["add", "Renew passport", "--due", "2026-03-01"], ["add", "Book dentist", "--due", "2026-03-20"], ["add", "Send invoice", "--due", "2026-03-09"], ["add", "Call bank", "--due", "2026-03-10"], ["add", "Water plants"], ["done", "5"]]) {
    const out = await cli(args)
    if (out.code !== 0) fail(`${args.join(" ")}: exit ${out.code}: ${out.stderr.trim().slice(0, 120)}`)
  }
  await expectList(
    ["list"],
    [
      "[ ] 3 Renew passport (overdue 2026-03-01)",
      "[x] 5 Send invoice (due 2026-03-09)",
      "[ ] 6 Call bank (due 2026-03-10)",
      "[ ] 2 Pay rent (due 2026-03-20)",
      "[ ] 4 Book dentist (due 2026-03-20)",
      "[ ] 1 Write report",
      "[ ] 7 Water plants",
    ],
    "list with due dates",
  )
  await expectList(["list", "--overdue"], ["[ ] 3 Renew passport (overdue 2026-03-01)"], "list --overdue")
  await expectList(["list", "--overdue"], ["[ ] 3 Renew passport (overdue 2026-03-01)", "[ ] 6 Call bank (overdue 2026-03-10)", "[ ] 2 Pay rent (overdue 2026-03-20)", "[ ] 4 Book dentist (overdue 2026-03-20)"], "list --overdue a month later", "2026-04-15")

  const before = await Bun.file(file).text()
  for (const bad of ["2026-02-30", "tomorrow", "2026-13-01", "2026-02-29", "2026-04-31"]) {
    const out = await cli(["add", "Bad date", "--due", bad])
    if (out.code !== 2) fail(`add --due ${bad} exits ${out.code}, expected 2`)
    if (out.stderr.trim() === "") fail(`add --due ${bad} says nothing on stderr`)
    if ((await Bun.file(file).text()) !== before) fail(`add --due ${bad} changed the task file`)
  }
  const leap = await cli(["add", "Leap day", "--due", "2024-02-29"])
  if (leap.code !== 0) fail("add --due 2024-02-29 (a real date) is rejected")
  await expectList(["list", "--overdue"], ["[ ] 8 Leap day (overdue 2024-02-29)", "[ ] 3 Renew passport (overdue 2026-03-01)"], "list --overdue with a leap-day task")
} finally {
  await rm(scratch, { recursive: true, force: true })
}
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
const files = await readTree(workspace)
const testsMention = [...files].some(([path, text]) => /\.test\.ts$/.test(path) && /overdue|--due|due:/.test(text))
if (!testsMention) fail("no test covers due dates")
pass("due dates are stored, validated, ordered and shown as asked, with tests")
