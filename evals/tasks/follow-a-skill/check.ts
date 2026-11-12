// The skill in the workspace (.claude/skills/schema-change) is the project's convention; the prompt does not repeat
// it. Graded on the outcome: one new migration numbered 0005 whose up adds a nullable TEXT nickname and whose down
// undoes it, the old migrations untouched, schema.sql regenerated (it equals what the migrations produce), a line
// for 0005 under "## Unreleased", the API returning nickname (null when unset, as the skill says), and the tests
// passing. The migration's name after the number is free.
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { errorLine, fail, importFrom, pass, pristine, readTree, requireUnchanged, run, workspaceArg } from "../../grader.ts"

type Migrate = typeof import("./workspace/src/migrate.ts")
const { dumpSchema, freshDatabase, migrateUp, readMigrations } = (await import(join(import.meta.dir, "workspace/src/migrate.ts"))) as Migrate

const workspace = workspaceArg()
const old = ["0001_create_users.sql", "0002_create_posts.sql", "0003_add_users_display_name.sql", "0004_index_posts_user.sql"]
await requireUnchanged(import.meta.dir, workspace, old.map((name) => `migrations/${name}`))
const files = await readTree(join(workspace, "migrations"))
const added = [...files.keys()].filter((name) => !old.includes(name))
if (added.length === 0) fail("there is no new migration in migrations/")
if (added.length > 1) fail(`more than one new file in migrations/: ${added.join(", ")}`)
if (!/^0005_[a-z0-9_]+\.sql$/.test(added[0]!)) fail(`the new migration is named ${added[0]}, not 0005_<snake_case>.sql`)

let migrations: ReturnType<typeof readMigrations>
try {
  migrations = readMigrations(join(workspace, "migrations"))
} catch (error) {
  fail(`the migrations cannot be read: ${String(error)}`)
}
const db = new Database(":memory:")
migrateUp(db, migrations.slice(0, 4))
const before = dumpSchema(db)
try {
  db.exec(migrations[4]!.up)
} catch (error) {
  fail(`0005's up section fails: ${String(error)}`)
}
const columns = db.query("PRAGMA table_info(users)").all() as { name: string; type: string; notnull: number }[]
const nickname = columns.find((column) => column.name === "nickname")
if (!nickname) fail(`users has no nickname column (columns: ${columns.map((column) => column.name).join(", ")})`)
if (nickname.type.toUpperCase() !== "TEXT") fail(`nickname is ${nickname.type}, not TEXT`)
if (nickname.notnull !== 0) fail("nickname is NOT NULL, but it should be optional")
db.exec("INSERT INTO users (email, created_at) VALUES ('a@example.com', '2026-01-01')")
const others = columns.filter((column) => column.name !== "nickname").map((column) => column.name).join()
if (others !== "id,email,created_at,display_name") fail(`0005 changed other columns of users: ${others}`)
db.exec("DELETE FROM users")
try {
  db.exec(migrations[4]!.down)
} catch (error) {
  fail(`0005's down section fails: ${String(error)}`)
}
if (dumpSchema(db) !== before) fail("0005's down section does not undo its up section")

const snapshot = Bun.file(join(workspace, "schema.sql"))
if (!(await snapshot.exists())) fail("schema.sql was deleted")
if ((await snapshot.text()) !== dumpSchema(freshDatabase(join(workspace, "migrations")))) fail("schema.sql is not what the migrations produce: it was not regenerated with scripts/schema-dump.ts")

const original = (await pristine(import.meta.dir)).get("docs/schema-changes.md")!
const changes = await Bun.file(join(workspace, "docs/schema-changes.md")).text()
const unreleased = /## Unreleased\n([\s\S]*?)(\n## |$)/.exec(changes)?.[1] ?? ""
if (!/^- 0005\b.*nickname/im.test(unreleased)) fail("docs/schema-changes.md has no line for 0005 (mentioning the nickname) under ## Unreleased")
for (const line of original.split("\n").filter((text) => text.startsWith("- "))) {
  if (!changes.includes(line)) fail(`docs/schema-changes.md lost the line "${line}"`)
}
const api = await importFrom<{ toApiUser: (row: Record<string, unknown>) => Record<string, unknown> }>(workspace, "src/users.ts")
const row = { id: 7, email: "zed@example.com", created_at: "2026-02-02", display_name: null }
const named = api.toApiUser({ ...row, nickname: "Zed" })
if (named.nickname !== "Zed") fail(`toApiUser does not return the nickname: ${JSON.stringify(named)}`)
const unnamed = api.toApiUser({ ...row, nickname: null })
if (!("nickname" in unnamed) || unnamed.nickname !== null) fail(`toApiUser leaves an unset nickname out or undefined instead of null: ${JSON.stringify(unnamed)}`)
const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
pass("a new 0005 migration with a working down, schema.sql regenerated, the change logged")
