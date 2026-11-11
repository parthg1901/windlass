import { join } from "node:path"

const dir = process.argv[2]!
for (const path of ["src/store.ts", "src/report.ts", "src/api.ts", "scripts/seed.ts", "README.md"]) {
  const file = join(dir, path)
  await Bun.write(file, (await Bun.file(file).text()).replace(/\bgetUsr\b/g, "getUserById"))
}
