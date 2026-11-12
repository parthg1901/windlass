import { join } from "node:path"

const path = join(process.argv[2]!, "src/slug.ts")
const text = await Bun.file(path).text()
await Bun.write(path, text.replace('.replace(/^-/, "")', '.replace(/^-+|-+$/g, "")'))
