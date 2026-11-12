import { join } from "node:path"

const dir = process.argv[2]!
const path = join(dir, "src/upload.ts")
await Bun.write(path, (await Bun.file(path).text()).replace("exeeds", "exceeds"))
for (const args of [["add", "src/upload.ts"], ["commit", "-q", "-m", "upload: fix the spelling of the size error", "-m", "Refs: #77"]]) {
  if (Bun.spawnSync(["git", ...args], { cwd: dir }).exitCode !== 0) throw new Error(`git ${args[0]} failed`)
}
