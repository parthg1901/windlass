// Reference: split on commas outside double quotes, and drop thousands separators before reading the amount.
import { join } from "node:path"

const path = join(process.argv[2]!, "src/csv.ts")
const text = await Bun.file(path).text()
const next = text
  .replace(
    'return line.split(",").map((field) => field.trim())',
    `const fields: string[] = []
  let current = ""
  let quoted = false
  for (const char of line) {
    if (char === '"') quoted = !quoted
    else if (char === "," && !quoted) {
      fields.push(current.trim())
      current = ""
    } else current += char
  }
  fields.push(current.trim())
  return fields`,
  )
  .replace("Number.parseFloat(text)", 'Number.parseFloat(text.replaceAll(",", ""))')
if (next === text) throw new Error("csv.ts did not match")
await Bun.write(path, next)
