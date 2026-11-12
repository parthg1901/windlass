import { join } from "node:path"

const dir = process.argv[2]!
const path = join(dir, "src/paginate.ts")
const text = await Bun.file(path).text()
await Bun.write(path, text.replace("items.length - 1)", "items.length)"))
await Bun.write(join(dir, "changes/482.fix.md"), "`paginate` returns every item on the last page when the total is not a multiple of the page size.\n")
