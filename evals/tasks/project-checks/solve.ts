import { join } from "node:path"

const src = join(process.argv[2]!, "src")
const edit = async (file: string, from: string, to: string) => {
  const path = join(src, file)
  const text = await Bun.file(path).text()
  if (!text.includes(from)) throw new Error(`${file}: ${from} not found`)
  await Bun.write(path, text.replace(from, to))
}
await edit("discount.ts", "subtotal > BULK_THRESHOLD", "subtotal >= BULK_THRESHOLD")
await edit("invoice.ts", "if (subtotal > 100)", "if (discount > 0)")
