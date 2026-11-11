import { unlink } from "node:fs/promises"
import { join } from "node:path"

const dir = process.argv[2]!
await unlink(join(dir, "db/dev.lock"))
const proc = Bun.spawnSync(["bun", "migrate.ts", "--env", "dev"], { cwd: dir, stdout: "inherit", stderr: "inherit" })
process.exit(proc.exitCode)
