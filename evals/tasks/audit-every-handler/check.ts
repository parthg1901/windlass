// Every handler is exercised on a fresh store and the audit log compared with what docs/audit.md requires: one
// entry per changed row, after the change, none for a no-op or a read. Behaviour must stay as it was (same rows,
// same return values), and the original tests must pass. How the calls are written is free.
import { join } from "node:path"
import { fail, importFrom, pass, requireOriginalTestsPass, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireOriginalTestsPass(import.meta.dir, workspace, ["src/audit.test.ts"])

type Row = { id: string; archived: boolean } & Record<string, unknown>
const { auditLog, clearAuditLog } = await importFrom<{ auditLog: { action: string; id: string }[]; clearAuditLog: () => void }>(workspace, "src/audit.ts")
const { createDb } = await importFrom<{ createDb: () => unknown }>(workspace, "src/db.ts")

const ENTITIES = [
  { name: "customer", cls: "Customer", file: "customers", title: "name", extra: { email: "a@example.com" } },
  { name: "order", cls: "Order", file: "orders", title: "reference", extra: { currency: "EUR" } },
  { name: "product", cls: "Product", file: "products", title: "sku", extra: { price: 1200 } },
  { name: "invoice", cls: "Invoice", file: "invoices", title: "number", extra: { dueDate: "2026-12-01" } },
  { name: "shipment", cls: "Shipment", file: "shipments", title: "tracking", extra: { weight: 900 } },
  { name: "ticket", cls: "Ticket", file: "tickets", title: "subject", extra: { priority: "high" } },
] as const

const problems: string[] = []
for (const entity of ENTITIES) {
  const mod = await importFrom<Record<string, (...args: unknown[]) => unknown>>(workspace, join("src/handlers", `${entity.file}.ts`))
  const fn = (verb: string, suffix = "") => {
    const handler = mod[`${verb}${entity.cls}${suffix}`]
    if (typeof handler !== "function") fail(`src/handlers/${entity.file}.ts has no ${verb}${entity.cls}${suffix}`)
    return handler
  }
  const log = () => auditLog.map((entry) => `${entry.action}:${entry.id}`)
  const expectLog = (what: string, want: string[]) => {
    const got = log()
    if (got.join() !== want.join()) problems.push(`${what}: audit log ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
    clearAuditLog()
  }
  const db = createDb()
  const n = entity.name
  clearAuditLog()
  const a = fn("create")(db, { [entity.title]: " First ", ...entity.extra }) as Row
  expectLog(`create${entity.cls}`, [`${n}.create:${a.id}`])
  const b = fn("create")(db, { [entity.title]: "Second" }) as Row
  const c = fn("create")(db, { [entity.title]: "Third" }) as Row
  clearAuditLog()
  if ((a[entity.title] as string) !== "First") problems.push(`create${entity.cls} no longer trims the ${entity.title}`)

  fn("get")(db, a.id)
  fn("list", "s")(db)
  fn("search", "s")(db, "first")
  fn("count", "s")(db)
  fn("export", "s")(db)
  expectLog(`the read handlers of ${entity.file}`, [])

  const updated = fn("update")(db, a.id, { [entity.title]: "First, changed" }) as Row
  expectLog(`update${entity.cls} with a change`, [`${n}.update:${a.id}`])
  if (updated[entity.title] !== "First, changed") problems.push(`update${entity.cls} no longer updates`)
  fn("update")(db, a.id, { [entity.title]: "First, changed" })
  expectLog(`update${entity.cls} without a change`, [])

  fn("rename")(db, b.id, "Second, renamed")
  expectLog(`rename${entity.cls}`, [`${n}.update:${b.id}`])
  fn("rename")(db, b.id, "Second, renamed")
  expectLog(`rename${entity.cls} to the same ${entity.title}`, [])

  const archived = fn("archive")(db, c.id) as Row
  fn("archive")(db, c.id)
  expectLog(`archive${entity.cls} twice`, [`${n}.archive:${c.id}`])
  if (archived.archived !== true) problems.push(`archive${entity.cls} no longer archives`)
  fn("restore")(db, c.id)
  fn("restore")(db, c.id)
  expectLog(`restore${entity.cls} twice`, [`${n}.restore:${c.id}`])

  fn("delete")(db, a.id)
  expectLog(`delete${entity.cls}`, [`${n}.delete:${a.id}`])
  let threw = false
  try {
    fn("delete")(db, a.id)
  } catch {
    threw = true
  }
  if (!threw) problems.push(`delete${entity.cls} of a missing row no longer throws`)
  expectLog(`delete${entity.cls} of a missing row`, [])

  const deleted = fn("bulkDelete", "s")(db, [c.id, "nope_1", b.id]) as string[]
  expectLog(`bulkDelete${entity.cls}s`, [`${n}.delete:${c.id}`, `${n}.delete:${b.id}`])
  if (JSON.stringify(deleted) !== JSON.stringify([c.id, b.id])) problems.push(`bulkDelete${entity.cls}s returns ${JSON.stringify(deleted)}`)
  if ((fn("count", "s")(db) as number) !== 0) problems.push(`the ${entity.file} store is not empty after deleting everything`)
}
if (problems.length > 0) fail(`${problems.length} problem(s); first: ${problems[0]}`)
pass("every changing handler audits exactly the rows it changed, and nothing else changed")
