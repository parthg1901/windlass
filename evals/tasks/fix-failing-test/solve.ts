import { join } from "node:path"

const file = join(process.argv[2]!, "src/duration.ts")
const source = await Bun.file(file).text()
await Bun.write(file, source.replace("Math.floor(totalSeconds / 60)", "Math.floor((totalSeconds % 3600) / 60)"))
