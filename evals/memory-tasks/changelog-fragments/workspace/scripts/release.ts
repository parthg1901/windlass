// Cuts a release: assembles the fragments in .changes/ into a new section at the top of CHANGELOG.md, bumps the
// version and deletes the fragments. `--dry-run` prints the section instead.
import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const TYPES = { feature: "Features", fix: "Fixes", docs: "Documentation", removal: "Removals" } as const
const fragments = readdirSync(join(root, ".changes"))
  .map((name) => /^(\d+)\.(feature|fix|docs|removal)\.md$/.exec(name))
  .filter((match) => match !== null)
  .map((match) => ({ file: match[0], issue: match[1]!, type: match[2] as keyof typeof TYPES }))
if (fragments.length === 0) {
  console.error("no fragments in .changes/")
  process.exit(1)
}
const pkg = await Bun.file(join(root, "package.json")).json()
const version = process.argv.find((arg) => /^\d+\.\d+\.\d+$/.test(arg)) ?? pkg.version
const lines = [`## ${version} (${new Date().toISOString().slice(0, 10)})`, ""]
for (const [type, title] of Object.entries(TYPES)) {
  const items = fragments.filter((fragment) => fragment.type === type)
  if (items.length === 0) continue
  lines.push(`### ${title}`, "")
  for (const item of items) lines.push(`- ${(await Bun.file(join(root, ".changes", item.file)).text()).trim()} (#${item.issue})`)
  lines.push("")
}
if (process.argv.includes("--dry-run")) {
  console.log(lines.join("\n"))
  process.exit(0)
}
const changelog = await Bun.file(join(root, "CHANGELOG.md")).text()
await Bun.write(join(root, "CHANGELOG.md"), changelog.replace("# Changelog\n\n", `# Changelog\n\n${lines.join("\n")}\n`))
for (const fragment of fragments) rmSync(join(root, ".changes", fragment.file))
console.log(`released ${version}`)
