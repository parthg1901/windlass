// Reference: an optional `due` on Task; parse --due in add; sort and suffix in list; --overdue filter.
import { join } from "node:path"

const dir = process.argv[2]!
const edit = async (file: string, from: string, to: string) => {
  const path = join(dir, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit("src/store.ts", "  readonly completedAt?: string\n", "  readonly completedAt?: string\n  /** YYYY-MM-DD */\n  readonly due?: string\n")
await edit(
  "src/format.ts",
  "export function formatTask(task: Task): string {\n  return `[${task.done ? \"x\" : \" \"}] ${task.id} ${task.title}`\n}",
  "export function formatTask(task: Task, today?: string): string {\n  const base = `[${task.done ? \"x\" : \" \"}] ${task.id} ${task.title}`\n  if (task.due === undefined) return base\n  const overdue = !task.done && today !== undefined && task.due < today\n  return `${base} (${overdue ? \"overdue\" : \"due\"} ${task.due})`\n}\n\nexport function isRealDate(text: string): boolean {\n  const match = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text)\n  if (!match) return false\n  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))\n  return date.toISOString().slice(0, 10) === text\n}",
)
await edit("src/commands.ts", 'import { formatTask } from "./format.ts"', 'import { formatTask, isRealDate } from "./format.ts"')
await edit(
  "src/commands.ts",
  "  const title = args.join(\" \").trim()\n  if (title === \"\") throw new UsageError('add needs a title: tasks add \"Buy milk\"')\n  const tasks = await load(path)\n  const task: Task = { id: nextId(tasks), title, done: false }",
  "  const rest = [...args]\n  let due: string | undefined\n  const at = rest.indexOf(\"--due\")\n  if (at !== -1) {\n    due = rest[at + 1]\n    if (due === undefined || !isRealDate(due)) throw new UsageError(`--due needs a date as YYYY-MM-DD: ${due ?? \"(none)\"}`)\n    rest.splice(at, 2)\n  }\n  const title = rest.join(\" \").trim()\n  if (title === \"\") throw new UsageError('add needs a title: tasks add \"Buy milk\"')\n  const tasks = await load(path)\n  const task: Task = { id: nextId(tasks), title, done: false, ...(due === undefined ? {} : { due }) }",
)
await edit(
  "src/commands.ts",
  "export async function list(path: string, _args: readonly string[], out: Output): Promise<void> {\n  const tasks = await load(path)\n  if (tasks.length === 0) out.stdout.push(\"nothing to do\")\n  for (const task of tasks) out.stdout.push(formatTask(task))\n}",
  "export async function list(path: string, args: readonly string[], out: Output, env: Record<string, string | undefined> = process.env): Promise<void> {\n  const now = today(env)\n  const all = await load(path)\n  const dated = all.filter((task) => task.due !== undefined).sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0))\n  let tasks = [...dated, ...all.filter((task) => task.due === undefined)]\n  if (args.includes(\"--overdue\")) tasks = tasks.filter((task) => !task.done && task.due !== undefined && task.due < now)\n  if (all.length === 0) out.stdout.push(\"nothing to do\")\n  for (const task of tasks) out.stdout.push(formatTask(task, now))\n}",
)
await edit("src/cli.ts", "await list(path, args, out)", "await list(path, args, out, env)")
await Bun.write(
  join(dir, "src/due.test.ts"),
  'import { expect, test } from "bun:test"\nimport { mkdtemp } from "node:fs/promises"\nimport { tmpdir } from "node:os"\nimport { join } from "node:path"\nimport { main } from "./cli.ts"\n\ntest("due dates and overdue", async () => {\n  const env = { TASKS_FILE: join(await mkdtemp(join(tmpdir(), "due-")), "t.json"), TASKS_TODAY: "2026-03-10" }\n  await main(["add", "Later", "--due", "2026-04-01"], env)\n  await main(["add", "Late", "--due", "2026-03-01"], env)\n  expect((await main(["list"], env)).stdout).toEqual(["[ ] 2 Late (overdue 2026-03-01)", "[ ] 1 Later (due 2026-04-01)"])\n  expect((await main(["add", "x", "--due", "2026-02-30"], env)).code).toBe(2)\n})\n',
)
