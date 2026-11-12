// Reference: add each missing audit call after the change it records.
import { join } from "node:path"

const dir = join(process.argv[2]!, "src/handlers")
const MISSING: Record<string, string[]> = {
  customers: ["update", "archive", "bulkDelete"],
  orders: ["create", "restore"],
  products: ["rename", "delete", "update"],
  invoices: ["archive"],
  shipments: ["create", "bulkDelete", "restore"],
  tickets: ["delete", "rename"],
}
for (const [file, ops] of Object.entries(MISSING)) {
  const path = join(dir, `${file}.ts`)
  let text = await Bun.file(path).text()
  const entity = file.slice(0, -1)
  const cls = entity[0]!.toUpperCase() + entity.slice(1)
  const patch = (from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
    text = text.replace(from, to)
  }
  for (const op of ops) {
    if (op === "create") patch("    archived: false,\n  })\n  return row", `    archived: false,\n  })\n  audit("${entity}.create", row.id)\n  return row`)
    if (op === "update") patch(`  if (changed.length === 0) return current\n  const row = db.update<${cls}>(TABLE, id, Object.fromEntries(changed))\n  return row`, `  if (changed.length === 0) return current\n  const row = db.update<${cls}>(TABLE, id, Object.fromEntries(changed))\n  audit("${entity}.update", id)\n  return row`)
    if (op === "rename") patch(`.trim() })\n  return row`, `.trim() })\n  audit("${entity}.update", id)\n  return row`)
    if (op === "archive") patch("{ archived: true })\n  return row", `{ archived: true })\n  audit("${entity}.archive", id)\n  return row`)
    if (op === "restore") patch("{ archived: false })\n  return row", `{ archived: false })\n  audit("${entity}.restore", id)\n  return row`)
    if (op === "delete") patch("  db.remove(TABLE, id)\n}", `  db.remove(TABLE, id)\n  audit("${entity}.delete", id)\n}`)
    if (op === "bulkDelete") patch("    db.remove(TABLE, id)\n    deleted.push(id)", `    db.remove(TABLE, id)\n    audit("${entity}.delete", id)\n    deleted.push(id)`)
  }
  await Bun.write(path, text)
}
