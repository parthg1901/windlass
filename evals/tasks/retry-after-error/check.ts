import { join } from "node:path"
import { fail, pass, requireUnchanged, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, [
  "migrate.ts",
  "db/test.json",
  "migrations/001_users.json",
  "migrations/002_orders.json",
  "migrations/003_order_status.json",
])
if (await Bun.file(join(workspace, "db/dev.lock")).exists()) fail("db/dev.lock is still there; the migration did not complete")
const db = await Bun.file(join(workspace, "db/dev.json")).json().catch(() => fail("db/dev.json is missing or not JSON"))
const checksum = async (name: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(join(workspace, `migrations/${name}.json`)).text()).digest("hex").slice(0, 12)
const expected = {
  version: 3,
  tables: { users: ["id", "email", "created_at"], orders: ["id", "user_id", "total_cents", "status"] },
  applied: [
    { name: "001_users", checksum: "6a3c2f8e0b1d" },
    { name: "002_orders", checksum: await checksum("002_orders") },
    { name: "003_order_status", checksum: await checksum("003_order_status") },
  ],
}
if (JSON.stringify(db) !== JSON.stringify(expected)) fail(`db/dev.json is not the migrated state: ${JSON.stringify(db)}`)
pass("dev is migrated to version 3 by the migration script")
