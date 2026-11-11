import { join } from "node:path"

const file = join(process.argv[2]!, "report.ts")
const source = await Bun.file(file).text()
await Bun.write(
  file,
  source
    .replace("  tags: string[]", "  tags?: string[] | null")
    .replace("for (const tag of order.tags)", "for (const tag of order.tags ?? [])")
    .replace("(order) => order.tags.length === 0", "(order) => (order.tags ?? []).length === 0"),
)
