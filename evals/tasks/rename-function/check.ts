import { fail, errorLine, importFrom, pass, pristine, readTree, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
const files = await readTree(workspace)
const original = await pristine(import.meta.dir)
for (const path of original.keys()) if (!files.has(path)) fail(`${path} was deleted`)
// The old name may survive only in a new note about the rename (a CHANGELOG entry, say), never in code or the docs.
const leftovers = [...files].filter(([path, text]) => /\bgetUsr\b/.test(text) && (original.has(path) || /\.[cm]?[jt]sx?$/.test(path))).map(([path]) => path)
if (leftovers.length > 0) fail(`getUsr is still mentioned in ${leftovers.join(", ")}`)
const store = await importFrom<Record<string, unknown>>(workspace, "src/store.ts")
if (typeof store.getUserById !== "function") fail("src/store.ts does not export a function named getUserById")
if (typeof store.getUsrsByTeam !== "function") fail("getUsrsByTeam was renamed or removed, but it should be left alone")
for (const path of ["src/report.ts", "src/api.ts", "scripts/seed.ts", "README.md"]) {
  if (!(files.get(path) ?? "").includes("getUserById")) fail(`${path} does not use getUserById`)
}

const expected = [
  "#1: Ada (core, 1 teammates)",
  "#2: Linus (infra, 0 teammates)",
  "#4: unknown",
  '{"status":200,"body":{"id":3,"name":"Grace","team":"core"}}',
  '{"status":404,"body":{"error":"not found"}}',
].join("\n")
const main = await run(["bun", "src/main.ts"], workspace)
if (main.code !== 0 || main.stdout.trim() !== expected) fail(`bun src/main.ts output changed: ${errorLine(main.output)}`)
const seed = await run(["bun", "scripts/seed.ts"], workspace)
if (seed.code !== 0) fail(`bun scripts/seed.ts fails: ${errorLine(seed.output)}`)
pass("getUsr is renamed to getUserById everywhere and behaviour is unchanged")
