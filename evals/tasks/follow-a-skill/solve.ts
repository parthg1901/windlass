import { join } from "node:path"

const dir = process.argv[2]!
await Bun.write(join(dir, "migrations/0005_add_users_nickname.sql"), "-- migrate:up\nALTER TABLE users ADD COLUMN nickname TEXT;\n-- migrate:down\nALTER TABLE users DROP COLUMN nickname;\n")
const proc = Bun.spawnSync(["bun", "scripts/schema-dump.ts"], { cwd: dir })
if (proc.exitCode !== 0) throw new Error("schema-dump failed")
const path = join(dir, "docs/schema-changes.md")
const text = await Bun.file(path).text()
await Bun.write(path, text.replace("## Unreleased\n\n", "## Unreleased\n\n- 0005: users have an optional nickname.\n"))
