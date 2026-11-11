import { join } from "node:path"

const file = join(process.argv[2]!, "src", "commands.ts")
const text = await Bun.file(file).text()
await Bun.write(file, text.replace("  record.archived === true\n", "  record.archived = true\n"))
